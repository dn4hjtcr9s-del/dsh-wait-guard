/**
 * wait-guard — a host-plane completion gate for delegated Agents.
 *
 * Guarantee: an Agent's turn does not close while any descendant subagent is
 * still running. The gate hangs off `agent/turn-stopping`, the event the loop
 * awaits immediately before it re-reads the inbox and decides whether to close
 * the turn, and it holds that decision open until the subtree is quiet.
 *
 * Release policy (v5): the gate DEACTIVATES completely the moment any message
 * reaches the paused Agent — a human prompt, a peer relay, or a runtime
 * settlement notice. Deactivation means the plugin is out of the way: it stops
 * waiting and injects nothing, so the arrival alone buys the model a free step
 * to think, call tools, or answer without committing. The gate is not gone for
 * good: the next time the model tries to close the turn, `agent/turn-stopping`
 * fires again and the gate re-engages immediately while descendants remain.
 * The only two ways to deactivate are therefore a message arriving and the
 * silence timer elapsing. Delivery was never gated at all — messages are
 * spliced into the inbox by the runtime, not through this plugin.
 *
 * Timer policy (v5): one notice per stop attempt, no more. When the timer
 * elapses the gate injects exactly one nudge and deactivates; the next stop
 * attempt starts a fresh timer. There is no per-turn quota and no escalation:
 * because a nudge can only be produced by the model asking to close the turn
 * again, the model's own attempts bound the frequency. Set `nudge: false` for a
 * completely silent gate.
 *
 * Timing (v3): elapsed wait is measured from the wall clock, not by counting
 * sleeps. Each probe round costs real time, so a sleep counter under-reports the
 * wait (measured ~2x on a live run).
 *
 * Design constraints (all deliberate):
 * - Zero imports. Nothing resolves at load time, so the plugin cannot break on
 *   module-resolution differences between the packaged app and a profile.
 * - Zero writes. It never edits configuration, settings, sessions, or files.
 * - Zero global state. Every listener is registered through `ctx.on`/`ctx.inject`
 *   and is disposed with the plugin; every timer is tracked and cleared, and
 *   pending waits resolve immediately on disposal.
 * - Uninstall = delete the row from the profile patch. Nothing else to undo.
 *
 * The only durable trace it can leave is an ordinary `user/message` notice in
 * the conversation (a nudge or a companion reminder), which is bounded by
 * configuration and is plain conversation content, not configuration state. The
 * notice `source.kind` names this producer directly; session format V4 refuses
 * the retired `{ kind: 'plugin', plugin: … }` wrapper outright.
 *
 * Multi-level coverage: pending work is probed over the whole descendant tree
 * (`listDescendants`), not just direct children, so a coordinator that is itself
 * idle while its own children run still keeps the gate closed. `listChildren`
 * is only a fallback when the tree probe is unavailable.
 *
 * @module @local/dsh-wait-guard
 */

export const name = 'wait-guard';

/** Both services are host-plane providers guaranteed by `@deepseek-ai/dsh-base`. */
export const inject = ['subagents', 'agents'];

/** Mirrors `CONTEXT_SUMMARY_MAX_CHARS` from the message layer. */
const CONTEXT_SUMMARY_MAX_CHARS = 120;

/** Sits immediately after the subagent tool guidance (TOOL_SUBAGENT = 2800). */
const SECTION_ORDER_FALLBACK = 2801;

const DEFAULTS = {
    firstWaitMs: 60_000,
    nudge: true,
    pollMs: 250,
    releaseOn: ['*'],
    companionReminder: false,
    maxCompanionPerTurn: 2,
    policySection: true,
    onProbeError: 'open',
    debug: false,
};

const POLICY_TEXT_DEFAULT = 'Subagent completion gate: before you give your final answer, every subagent you '
    + 'dispatched must have settled. Their results arrive as messages, and a subagent that has not settled is '
    + 'invisible in your context, so use list_agents(scope:\'descendants\') when you are unsure. Do not sleep-poll, '
    + 'and never present a partial result as final. If one is genuinely stuck, interrupt_agent stops its current '
    + 'turn and produces a settlement notice, which ends the wait.';

const NUDGE_TEXT_DEFAULT = '仍在等待 {n} 个子代理结算（已等待约 {s} 秒）：{list}。\n'
    + '现在不要给出最终结论 —— 所有已派出的子代理都必须先结束。\n'
    + '可用 list_agents(scope:\'descendants\') 查看状态、send_message 询问进展；'
    + '若某个确实卡住，interrupt_agent 会中止它当前的工作并产生结算通知，等待随即结束。不要用 sleep 轮询。';

const COMPANION_TEXT_DEFAULT = '注意：仍有 {n} 个子代理在运行：{list}。刚收到的内容只是进展，不是最终结果 —— '
    + '请勿据此给出最终结论，也不要停止等待。';

//#region config

function positiveInt(value, fallback, min = 1) {
    return Number.isSafeInteger(value) && value >= min && value <= Number.MAX_SAFE_INTEGER ? value : fallback;
}

function text(value, fallback) {
    return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/** Normalize an untrusted plugin config block into a complete, safe shape. */
export function resolveConfig(config) {
    const raw = config !== null && typeof config === 'object' ? config : {};
    const releaseOn = Array.isArray(raw.releaseOn) && raw.releaseOn.length > 0
        && raw.releaseOn.every((entry) => typeof entry === 'string' && entry.length > 0)
        ? [...raw.releaseOn]
        : [...DEFAULTS.releaseOn];
    return {
        firstWaitMs: positiveInt(raw.firstWaitMs, DEFAULTS.firstWaitMs),
        nudge: raw.nudge !== false,
        pollMs: positiveInt(raw.pollMs, DEFAULTS.pollMs, 5),
        releaseOn,
        companionReminder: raw.companionReminder === true,
        maxCompanionPerTurn: positiveInt(raw.maxCompanionPerTurn, DEFAULTS.maxCompanionPerTurn, 0),
        policySection: raw.policySection !== false,
        onProbeError: raw.onProbeError === 'closed' ? 'closed' : 'open',
        debug: raw.debug === true,
        policyText: text(raw.policyText, POLICY_TEXT_DEFAULT),
        nudgeText: text(raw.nudgeText, NUDGE_TEXT_DEFAULT),
        companionText: text(raw.companionText, COMPANION_TEXT_DEFAULT),
    };
}

//#endregion

//#region message construction (no imports: the session log treats user/message payloads as opaque)

let idCounter = 0;

function newMessageId() {
    const crypto = globalThis.crypto;
    if (crypto !== undefined && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    idCounter += 1;
    return `wait-guard-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function oneLine(value) {
    return String(value).replace(/\s+/g, ' ').trim();
}

function boundSummary(value) {
    const line = oneLine(value);
    return line.length <= CONTEXT_SUMMARY_MAX_CHARS ? line : `${line.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * Build one producer-attributed notice accepted by the Agent inbox.
 * `kind` names this producer itself: session format V4 refuses the retired
 * `{ kind: 'plugin', plugin: … }` wrapper, and naming the producer is what keeps
 * a version-4 Session readable instead of unsupported.
 */
function noticeMessage(producer, body) {
    return {
        id: newMessageId(),
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: {
            kind: producer,
            form: 'notice',
            summary: boundSummary(body),
        },
    };
}

function render(template, values) {
    return template
        .replaceAll('{n}', String(values.count))
        .replaceAll('{s}', String(values.seconds))
        .replaceAll('{list}', values.list);
}

function labelOf(entry) {
    const id = typeof entry?.id === 'string' ? entry.id : 'unknown';
    const label = typeof entry?.label === 'string' && entry.label.length > 0 ? ` (${entry.label})` : '';
    return `${id}${label}`;
}

//#endregion

//#region plugin

/**
 * Install the gate.
 * @param ctx - host-plane context carrying the subagent service and Agent registry.
 * @param config - optional tuning block from the plugin row.
 */
export function apply(ctx, config) {
    const cfg = resolveConfig(config);
    const agents = ctx.agents;
    const subagents = ctx.subagents;

    /** agentId -> per-turn bookkeeping (companion reminders already spent). */
    const tracker = new Map();
    /** Resolvers of in-flight sleeps, so disposal can release every pending wait. */
    const pendingResolvers = new Set();
    let disposed = false;

    const debug = (...args) => {
        if (cfg.debug) ctx.logger?.info?.(`[${name}]`, ...args);
    };

    /** Resolve when the plugin is unloaded, so a wait never outlives its plugin. */
    ctx.effect(function* guardLifetime() {
        yield () => {
            disposed = true;
            for (const finish of [...pendingResolvers]) finish();
            pendingResolvers.clear();
            tracker.clear();
        };
    });

    const sleep = (ms) => new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pendingResolvers.delete(finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        pendingResolvers.add(finish);
    });

    /**
     * Running entries across the whole descendant tree.
     * @returns the running entries, or `null` when no listing could be read.
     */
    const probe = async (agent, signal) => {
        const running = (list) => {
            if (!Array.isArray(list)) return null;
            return list.filter((entry) => {
                if (entry === null || typeof entry !== 'object') return false;
                if (entry.kind === 'diagnostic') return false;
                if (typeof entry.id !== 'string' || entry.id.length === 0) return false;
                return agents?.get?.(entry.id)?.status === 'running';
            });
        };
        try {
            const tree = running(await subagents.listDescendants(agent.id, signal));
            if (tree !== null) return tree;
        } catch (error) {
            debug('listDescendants failed', error);
        }
        try {
            const kids = running(await subagents.listChildren(agent.id, signal));
            if (kids !== null) return kids;
        } catch (error) {
            debug('listChildren failed', error);
        }
        return null;
    };

    const keyOf = (message) => `${message?.source?.kind ?? '?'}:${message?.id ?? '?'}`;

    const snapshot = (agent) => {
        const seen = new Set();
        for (const list of [agent?.inbox?.nextStep, agent?.inbox?.nextTurn]) {
            if (!Array.isArray(list)) continue;
            for (const message of list) seen.add(keyOf(message));
        }
        return seen;
    };

    const fresh = (list, seen) => (Array.isArray(list) ? list.filter((message) => !seen.has(keyOf(message))) : []);

    /** `'*'` releases on every arrival; otherwise only the listed source kinds do. */
    const releases = (message) => cfg.releaseOn.includes('*')
        || cfg.releaseOn.includes(message?.source?.kind);

    const steerNotice = (agent, body) => {
        try {
            if (typeof agent?.steer !== 'function') return;
            agent.steer(noticeMessage(name, body));
        } catch (error) {
            debug('steer failed', error);
        }
    };

    const bodyFor = (entries) => {
        const shown = entries.slice(0, 8).map(labelOf).join(', ');
        return entries.length > 8 ? `${shown}, … (+${entries.length - 8})` : shown;
    };

    const stateFor = (agentId, turn) => {
        const current = tracker.get(agentId);
        if (current !== undefined && current.turn === turn) return current;
        const next = { turn, companions: 0 };
        tracker.set(agentId, next);
        return next;
    };

    const canDelegate = (context) => {
        const depth = context?.agent?.session?.header?.delegationDepth ?? 0;
        let limit;
        try {
            limit = subagents.resolveMaxDepth?.(undefined);
        } catch {
            limit = undefined;
        }
        // Unknown or provider-managed depth policy: assume the agent can delegate.
        if (typeof limit !== 'number') return true;
        return depth + 1 <= limit;
    };

    if (cfg.policySection) {
        ctx.inject(['systemPrompt'], (promptCtx) => {
            let order = SECTION_ORDER_FALLBACK;
            try {
                const known = promptCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT');
                if (typeof known === 'number') order = known + 1;
            } catch {
                /* keep the fallback slot */
            }
            try {
                promptCtx.systemPrompt.section({
                    name: `tool:${name}`,
                    order,
                    text: (context) => {
                        try {
                            return canDelegate(context) ? cfg.policyText : '';
                        } catch {
                            return '';
                        }
                    },
                });
            } catch (error) {
                // A reload can briefly overlap the previous instance, and the prompt
                // registry refuses duplicate section names. Losing the policy text is
                // survivable; failing `apply` would take the whole gate down with it.
                debug('policy section not registered', error);
            }
        });
    }

    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
        if (disposed || agent === undefined || agent === null) return;

        let current = await probe(agent, signal);
        if (current === null) {
            if (cfg.onProbeError === 'open') {
                debug('no listing available; releasing the turn');
                return;
            }
            current = [{ id: 'unavailable' }];
        }
        if (current.length === 0) return;

        const seen = snapshot(agent);
        const state = stateFor(agent.id, turn);
        const startAt = Date.now();

        while (!disposed && signal?.aborted !== true) {
            const now = Date.now();
            const waited = now - startAt;

            // 1) The subtree went quiet: whatever arrived is already parked in next-step.
            const running = await probe(agent, signal);
            if (running !== null && running.length === 0) return;
            const pendingNow = () => (Array.isArray(running) ? running : current);

            // 2) DEACTIVATION PATH 1 — a message arrived. The plugin leaves entirely:
            //    stop waiting and inject nothing, so this step belongs to the Agent.
            const stepArrivals = fresh(agent.inbox?.nextStep, seen);
            const turnArrivals = fresh(agent.inbox?.nextTurn, seen);
            const stepReleased = stepArrivals.some(releases);
            const turnReleased = turnArrivals.some(releases);
            if (stepReleased || turnReleased) {
                // Opt-in only, and only for a next-step arrival: a queued human turn must
                // not be pushed into yet another step by an injected reminder.
                if (stepReleased && cfg.companionReminder && state.companions < cfg.maxCompanionPerTurn) {
                    const pending = pendingNow();
                    if (pending.length > 0) {
                        state.companions += 1;
                        steerNotice(agent, render(cfg.companionText, {
                            count: pending.length,
                            seconds: Math.round(waited / 1000),
                            list: bodyFor(pending),
                        }));
                    }
                }
                return;
            }

            // 3) DEACTIVATION PATH 2 — the silence timer elapsed. Exactly one notice per
            //    stop attempt, then leave immediately: a notice parked behind a held turn
            //    could never be claimed, and the Agent needs the chance to intervene
            //    (interrupt_agent, send_message). Re-engaging starts a fresh timer.
            if (cfg.nudge && waited >= cfg.firstWaitMs) {
                const pending = pendingNow();
                steerNotice(agent, render(cfg.nudgeText, {
                    count: pending.length,
                    seconds: Math.round(waited / 1000),
                    list: bodyFor(pending),
                }));
                return;
            }

            await sleep(cfg.pollMs);
        }
    });
}

//#endregion
