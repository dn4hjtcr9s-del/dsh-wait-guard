/**
 * Self-test for wait-guard. Runs on plain Node with a fake host context — no
 * DSH install required: `node test/self-test.mjs`.
 *
 * Regression coverage worth naming:
 * - wall-clock wait accounting (a sleep counter under-reports and stretches the
 *   escalation schedule);
 * - a nudge must RELEASE the gate, because a notice parked in `next-step` behind
 *   a held turn can never be claimed;
 * - the default release policy ends the pause on ANY arrival.
 */
import { apply, name, inject, resolveConfig } from '../lib/index.js';

const results = [];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function test(title, fn) {
    try {
        await fn();
        results.push([title, 'PASS', '']);
    } catch (error) {
        results.push([title, 'FAIL', error?.message ?? String(error)]);
    }
}

const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: did not settle within ${ms}ms`)), ms)),
]);

/** Report whether `promise` settled inside `ms` (without failing the test on timeout). */
async function settledWithin(promise, ms) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, ms));
    return done;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeHarness(config = {}, options = {}) {
    const listeners = new Map();
    const disposers = [];
    const sections = [];
    const registry = new Map();
    const state = {
        tree: options.tree ?? [],
        children: options.children ?? null,
        treeThrows: options.treeThrows === true,
        childrenThrows: options.childrenThrows === true,
        probeDelayMs: options.probeDelayMs ?? 0,
        probes: 0,
    };

    const ctx = {
        agents: { get: (id) => registry.get(id) },
        subagents: {
            listDescendants: async () => {
                state.probes += 1;
                if (state.probeDelayMs > 0) await sleep(state.probeDelayMs);
                if (state.treeThrows) throw new Error('listDescendants unavailable');
                return state.tree;
            },
            listChildren: async () => {
                if (state.probeDelayMs > 0) await sleep(state.probeDelayMs);
                if (state.childrenThrows) throw new Error('listChildren unavailable');
                return state.children ?? state.tree;
            },
            resolveMaxDepth: () => options.maxDepth ?? 1,
        },
        on: (event, listener) => { listeners.set(event, listener); },
        effect: (fn) => {
            const iterator = fn();
            const step = iterator.next();
            if (typeof step.value === 'function') disposers.push(step.value);
        },
        inject: (_deps, callback) => { callback(ctx); },
        logger: { info: () => {}, warn: () => {} },
        systemPrompt: {
            getSectionOrder: (key) => (key === 'TOOL_SUBAGENT' ? 2800 : undefined),
            section: (section) => sections.push(section),
        },
    };

    apply(ctx, config);

    const agent = {
        id: options.agentId ?? 'session-main',
        session: { header: { delegationDepth: options.depth ?? 0 } },
        inbox: { nextStep: [], nextTurn: [] },
        sent: [],
        steer(message) { this.sent.push(message); },
    };

    return {
        agent,
        ctx,
        state,
        registry,
        sections,
        disposers,
        hook: listeners.get('agent/turn-stopping'),
        disposeAll: () => { for (const dispose of disposers) dispose(); },
    };
}

const run = (registry, id, status) => registry.set(id, { id, status });
const settle = (registry, id) => registry.set(id, { id, status: 'idle' });

const arrival = (kind, id, sender = 'child-1') => ({
    id,
    role: 'user',
    content: [{ type: 'text', text: `${kind} ${id}` }],
    source: kind === 'user'
        ? { kind: 'user' }
        : kind === 'agent-message'
            ? { kind: 'agent-message', form: 'relay', senderSessionId: sender }
            : { kind: 'subagent-settled', form: 'notice', summary: 'settled', senderSessionId: sender },
});

const FAST = { firstWaitMs: 40, pollMs: 5, maxWaitMs: 40, maxNudgesPerTurn: 2, maxCompanionPerTurn: 1 };
const invoke = (h, turn = 1, signal = new AbortController().signal) => h.hook({ agent: h.agent, turn, signal });

//#region session-format-v4 admission guard

/**
 * Local copy of the session-format V4 producer-attribution rule (`source()` in
 * `@deepseek-ai/session-format-v3-to-v4`), kept here so the self-test needs no
 * DSH install. The real check is a hard refusal, so a regression here means an
 * unreadable Session, not a warning.
 */
function v4SourceRefusal(message) {
    const value = message?.source;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'source must be a JSON object';
    if (typeof value.kind !== 'string') return 'source.kind must be a string';
    if (value.kind.length === 0) return 'source.kind must not be empty';
    if (value.kind === 'plugin') return 'the retired plugin wrapper is refused';
    return null;
}

/** The durable slots V4 audits, keyed by owning event; `user/message` uses `data`. */
function v4AuditedMessages(type, data) {
    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isObject(data)) return [];
    if (type === 'user/message') return [data];
    if (type === 'system/message' || type === 'developer/message' || type === 'assistant/message' || type === 'tool/result') {
        return isObject(data.message) ? [data.message] : [];
    }
    if (type === 'agent/inbox/spliced') return Array.isArray(data.inserted) ? data.inserted.filter(isObject) : [];
    if (type === 'session/title-llm-request') return Array.isArray(data.messages) ? data.messages.filter(isObject) : [];
    return [];
}

//#endregion

//#region tests

await test('exports a loadable plugin shape', () => {
    assert(name === 'wait-guard', 'unexpected plugin name');
    assert(Array.isArray(inject) && inject.includes('subagents') && inject.includes('agents'), 'inject list must carry the host services');
});

await test('no pending descendants: releases immediately, injects nothing', async () => {
    const h = makeHarness(FAST);
    h.state.tree = [];
    await withTimeout(invoke(h), 200, 'hook');
    assert(h.agent.sent.length === 0, 'must not inject anything when nothing is pending');
});

await test('one running child: waits, then releases when the child settles', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 120 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }];
    run(h.registry, 'child-1', 'running');
    setTimeout(() => { h.state.tree = []; settle(h.registry, 'child-1'); }, 25);
    await withTimeout(invoke(h), 500, 'hook');
    assert(h.agent.sent.length === 0, 'a wait shorter than firstWaitMs must not nudge');
});

await test('multi-level: idle coordinator with a running grandchild still holds the gate', async () => {
    // firstWaitMs is long on purpose: a due nudge releases the gate by design, so this
    // case is about the hold itself rather than about the reminder.
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000 });
    h.state.tree = [
        { kind: 'child', id: 'child-1', depth: 1 },
        { kind: 'child', id: 'grandchild-1', depth: 2, parent: 'child-1' },
    ];
    run(h.registry, 'child-1', 'idle');
    run(h.registry, 'grandchild-1', 'running');
    const pending = invoke(h);
    assert(await settledWithin(pending, 60) === false, 'gate must stay closed while a grandchild runs');
    h.state.tree = [];
    settle(h.registry, 'grandchild-1');
    await withTimeout(pending, 300, 'hook');
});

await test('default policy: an arrival deactivates the plugin completely, injecting nothing', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }, { kind: 'child', id: 'child-2' }];
    run(h.registry, 'child-1', 'running');
    run(h.registry, 'child-2', 'running');
    const pending = invoke(h);
    setTimeout(() => {
        h.agent.inbox.nextStep.push(arrival('subagent-settled', 'notice-1'));
        settle(h.registry, 'child-1');
    }, 15);
    await withTimeout(pending, 400, 'hook');
    assert(h.agent.sent.length === 0, `deactivation must add no message of its own, got ${h.agent.sent.length}`);
});

await test('deactivation is temporary: the very next stop attempt re-engages the gate', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }, { kind: 'child', id: 'child-2' }];
    run(h.registry, 'child-1', 'running');
    run(h.registry, 'child-2', 'running');
    const first = invoke(h, 9);
    setTimeout(() => { h.agent.inbox.nextStep.push(arrival('subagent-settled', 'notice-1')); }, 15);
    await withTimeout(first, 400, 'first hook');

    const second = invoke(h, 9);
    assert(await settledWithin(second, 120) === false, 'the model may not close the turn while child-2 still runs');
    h.state.tree = [];
    settle(h.registry, 'child-2');
    await withTimeout(second, 300, 'second hook');
});

await test('opt-in companion reminder still speaks on a next-step arrival', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000, companionReminder: true, maxCompanionPerTurn: 1 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }, { kind: 'child', id: 'child-2' }];
    run(h.registry, 'child-1', 'running');
    run(h.registry, 'child-2', 'running');
    const pending = invoke(h);
    setTimeout(() => {
        h.agent.inbox.nextStep.push(arrival('subagent-settled', 'notice-1'));
        settle(h.registry, 'child-1');
    }, 15);
    await withTimeout(pending, 400, 'hook');
    assert(h.agent.sent.length === 1, `expected exactly one companion reminder, got ${h.agent.sent.length}`);
    const message = h.agent.sent[0];
    assert(message.role === 'user' && Array.isArray(message.content), 'reminder must be a user message');
    assert(message.source.kind === 'wait-guard' && message.source.form === 'notice', 'reminder needs producer attribution');
    assert(message.content[0].text.includes('child-2'), 'reminder must name the still-running child');
});

await test('opt-in batching: releaseOn without settlements keeps the gate closed until the tree is quiet', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000, releaseOn: ['user', 'agent-message'] });
    h.state.tree = [{ kind: 'child', id: 'child-1' }, { kind: 'child', id: 'child-2' }];
    run(h.registry, 'child-1', 'running');
    run(h.registry, 'child-2', 'running');
    const pending = invoke(h);
    setTimeout(() => {
        h.agent.inbox.nextStep.push(arrival('subagent-settled', 'notice-1'));
        settle(h.registry, 'child-1');
    }, 15);
    assert(await settledWithin(pending, 120) === false, 'a settlement notice must not open the gate in opt-in batching mode');
    h.state.tree = [];
    settle(h.registry, 'child-2');
    await withTimeout(pending, 300, 'hook');
    assert(h.agent.sent.length === 0, 'no companion is needed when the tree simply goes quiet');
});

await test('child relay in next-step: deactivates the gate at once', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }];
    run(h.registry, 'child-1', 'running');
    const pending = invoke(h);
    setTimeout(() => { h.agent.inbox.nextStep.push(arrival('agent-message', 'msg-1')); }, 15);
    await withTimeout(pending, 400, 'hook');
    assert(h.agent.sent.length === 0, 'a relay ends the pause on its own; the plugin adds nothing');
});

await test('new human message in next-turn: releases early and injects nothing', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }];
    run(h.registry, 'child-1', 'running');
    const pending = invoke(h);
    setTimeout(() => { h.agent.inbox.nextTurn.push(arrival('user', 'queued-1')); }, 15);
    await withTimeout(pending, 400, 'hook');
    assert(h.agent.sent.length === 0, 'a queued human turn must not be delayed by an injected reminder');
});

await test('wall clock: the nudge fires on real time even when probes are slow', async () => {
    const h = makeHarness(
        { firstWaitMs: 1_000, pollMs: 5, maxWaitMs: 1_000, maxNudgesPerTurn: 1, maxCompanionPerTurn: 0 },
        { tree: [{ kind: 'child', id: 'child-1' }], probeDelayMs: 15 },
    );
    run(h.registry, 'child-1', 'running');
    const started = Date.now();
    await withTimeout(invoke(h), 3_000, 'hook');
    const elapsed = Date.now() - started;
    assert(h.agent.sent.length === 1, `expected one nudge, got ${h.agent.sent.length}`);
    assert(h.agent.sent[0].content[0].text.includes('约 1 秒'), `nudge must report real elapsed seconds, got: ${h.agent.sent[0].content[0].text.slice(0, 60)}`);
    assert(elapsed < 1_800, `sleep counting would take ~4s here; wall clock must nudge near 1s (took ${elapsed}ms)`);
});

await test('a nudge releases the gate so the model can actually read it', async () => {
    const h = makeHarness({ firstWaitMs: 20, pollMs: 5, maxWaitMs: 20, maxNudgesPerTurn: 3, maxCompanionPerTurn: 0 });
    h.state.tree = [{ kind: 'child', id: 'child-1', label: 'research' }];
    run(h.registry, 'child-1', 'running');
    await withTimeout(invoke(h), 400, 'hook');
    assert(h.agent.sent.length === 1, 'the nudge must be delivered');
    assert(h.agent.sent[0].content[0].text.includes('child-1'), 'nudge must name the pending child');
    assert(h.agent.sent[0].content[0].text.includes('interrupt_agent'), 'nudge must offer the interrupt escape hatch');
    assert(h.state.tree.length === 1, 'the child is still running: the gate released, it did not wait it out');
});

await test('timer policy: one notice per stop attempt, a fresh timer on every re-engagement', async () => {
    const h = makeHarness({ firstWaitMs: 20, pollMs: 5, maxCompanionPerTurn: 0 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }];
    run(h.registry, 'child-1', 'running');
    await withTimeout(invoke(h, 7), 400, 'first hook');
    assert(h.agent.sent.length === 1, 'the first stop attempt emits exactly one notice');
    // The gate deactivated; the model tried to close again, so the gate re-engaged
    // and its timer restarted: exactly one more notice, no quota, no escalation.
    await withTimeout(invoke(h, 7), 400, 'second hook');
    assert(h.agent.sent.length === 2, `every attempt earns one notice, got ${h.agent.sent.length}`);
});

await test('timer policy: nudge:false turns the time path off, keeping the gate silent', async () => {
    const h = makeHarness({ firstWaitMs: 20, pollMs: 5, nudge: false, maxCompanionPerTurn: 0 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }];
    run(h.registry, 'child-1', 'running');
    const pending = invoke(h, 8);
    assert(await settledWithin(pending, 120) === false, 'without the timer the gate holds until the tree is quiet');
    h.state.tree = [];
    settle(h.registry, 'child-1');
    await withTimeout(pending, 300, 'hook');
    assert(h.agent.sent.length === 0, 'a silent gate never speaks');
});

await test('abort releases the gate at once', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }];
    run(h.registry, 'child-1', 'running');
    const controller = new AbortController();
    const pending = invoke(h, 1, controller.signal);
    setTimeout(() => controller.abort('user'), 20);
    await withTimeout(pending, 300, 'hook');
    assert(h.agent.sent.length === 0, 'abort must not inject anything');
});

await test('disposal releases an in-flight wait immediately', async () => {
    const h = makeHarness({ ...FAST, firstWaitMs: 5_000 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }];
    run(h.registry, 'child-1', 'running');
    const pending = invoke(h);
    setTimeout(() => h.disposeAll(), 20);
    await withTimeout(pending, 300, 'hook');
    assert(h.agent.sent.length === 0, 'disposal must not inject anything');
});

await test('probe failure: fails open by default, can fail closed on request', async () => {
    const open = makeHarness(FAST, { treeThrows: true, childrenThrows: true });
    await withTimeout(invoke(open), 300, 'open hook');

    const closed = makeHarness({ ...FAST, onProbeError: 'closed', firstWaitMs: 5_000 }, { treeThrows: true, childrenThrows: true });
    const pending = invoke(closed);
    assert(await settledWithin(pending, 60) === false, 'fail-closed must keep waiting when no listing can be read');
    closed.disposeAll();
    await withTimeout(pending, 300, 'closed hook');
});

await test('every emitted notice survives session-format-v4 source admission', async () => {
    // Both notice kinds are exercised: an opt-in companion on an arrival, then a nudge.
    const h = makeHarness({
        firstWaitMs: 20, pollMs: 5, maxWaitMs: 20, maxNudgesPerTurn: 3, maxCompanionPerTurn: 1, companionReminder: true,
    });
    h.state.tree = [{ kind: 'child', id: 'child-1' }, { kind: 'child', id: 'child-2' }];
    run(h.registry, 'child-1', 'running');
    run(h.registry, 'child-2', 'running');
    const pending = invoke(h, 4);
    setTimeout(() => {
        h.agent.inbox.nextStep.push(arrival('subagent-settled', 'notice-1'));
        settle(h.registry, 'child-1');
    }, 10);
    await withTimeout(pending, 500, 'hook');
    assert(h.agent.sent.length === 1, 'the companion must be the first notice');

    await withTimeout(invoke(h, 4), 500, 'nudge hook');
    assert(h.agent.sent.length === 2, 'the second stop attempt emits a nudge');
    assert(h.agent.sent[1].content[0].text.includes('仍在等待'), 'the second notice must be the nudge');

    for (const message of h.agent.sent) {
        const refusal = v4SourceRefusal(message);
        assert(refusal === null, `notice would not be admitted by V4: ${refusal}`);
        for (const audited of v4AuditedMessages('user/message', message)) {
            assert(v4SourceRefusal(audited) === null, 'audited copy must also pass');
        }
    }
});

await test('policy section: registered once, after the subagent slot, only for delegating agents', () => {
    const h = makeHarness(FAST);
    assert(h.sections.length === 1, 'exactly one policy section');
    const section = h.sections[0];
    assert(section.name === 'tool:wait-guard', `unexpected section name ${section.name}`);
    assert(section.order === 2801, `expected order 2801, got ${section.order}`);
    assert(typeof section.text === 'function', 'section text must be a predicate function');
    const mainAgent = { agent: { session: { header: { delegationDepth: 0 } } } };
    const leafChild = { agent: { session: { header: { delegationDepth: 1 } } } };
    assert(section.text(mainAgent).length > 0, 'the main agent must receive the policy');
    assert(section.text(leafChild) === '', 'an agent that cannot delegate must not receive the policy');
});

await test('policy section is skipped when disabled', () => {
    const h = makeHarness({ ...FAST, policySection: false });
    assert(h.sections.length === 0, 'policySection:false must register nothing');
});

await test('config validation falls back to safe defaults', () => {
    const cfg = resolveConfig({
        firstWaitMs: -1,
        pollMs: 1,
        releaseOn: [],
        onProbeError: 'sideways',
        nudgeText: '   ',
        // Retired v1/v2 knobs: still tolerated in YAML, simply ignored now.
        waitFactor: 0.5,
        maxWaitMs: 'soon',
        maxNudgesPerTurn: 1.5,
        giveUpAfterMs: -5,
    });
    assert(cfg.firstWaitMs === 60_000, 'firstWaitMs must fall back');
    assert(cfg.pollMs === 250, 'pollMs must respect its floor');
    assert(cfg.nudge === true, 'the timer path is on by default');
    assert(cfg.releaseOn.length === 1 && cfg.releaseOn[0] === '*', 'releaseOn must fall back to release-on-anything');
    assert(cfg.onProbeError === 'open', 'unknown onProbeError must fail open');
    assert(cfg.nudgeText.includes('{n}'), 'blank nudgeText must fall back to the default template');
    assert(resolveConfig(undefined).nudge === true, 'a missing config block must resolve to defaults');
    assert(resolveConfig({ nudge: false }).nudge === false, 'nudge:false must be honoured');
    assert(resolveConfig({ maxNudgesPerTurn: 1 }).nudge === true, 'a retired knob must not switch the timer off');
});

await test('notice ids are unique and summaries stay bounded', async () => {
    const h = makeHarness({ firstWaitMs: 10, pollMs: 5, maxWaitMs: 10, maxNudgesPerTurn: 3, maxCompanionPerTurn: 0 });
    h.state.tree = [{ kind: 'child', id: 'child-1' }];
    run(h.registry, 'child-1', 'running');
    for (let turn = 1; turn <= 4; turn += 1) {
        await withTimeout(invoke(h, turn), 400, `invoke ${turn}`);
        await sleep(5);
    }
    const ids = h.agent.sent.map((message) => message.id);
    assert(ids.length >= 3, `expected several nudges, got ${ids.length}`);
    assert(new Set(ids).size === ids.length, 'message ids must be unique');
    for (const message of h.agent.sent) {
        assert(message.source.summary.length <= 120, 'summary bound violated');
        assert(message.content[0].text.length > 0, 'notice body must not be empty');
    }
});

//#endregion

let failed = 0;
for (const [title, status, detail] of results) {
    if (status === 'FAIL') failed += 1;
    console.log(`${status.padEnd(4)}  ${title}${detail ? `\n      ↳ ${detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
