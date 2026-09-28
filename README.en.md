# dsh-wait-guard

A **completion gate for DeepSeek Harness agents**: as long as any subagent an Agent dispatched is still `running`, that Agent's turn is not allowed to end.

It is a **pure Host-only plugin** — no tools registered, no settings written, no files touched, no global state. Remove the bundle and everything is exactly as it was.

[中文说明](README.md)

---

## Install

```sh
dsh plugin --profile <your-profile> add dsh-wait-guard
```

Or, in the Web UI: **Plugins → Add plugin** → `dsh-wait-guard`. Installing a bundle activates through HMR; replacing an already-installed package needs a restart to load a fresh module generation.

Uninstall: remove the bundle from the same page, or `dsh plugin --profile <your-profile> remove dsh-wait-guard`.

---

## What it guarantees

| | |
|---|---|
| ✅ **Guaranteed** | A delegating Agent's turn cannot end while **any descendant** is still `running` — including the case where an intermediate agent is idle between turns but its own children are running |
| ✅ Guaranteed | **Any arrival ends the pause**: a human message, a peer relay, or a runtime settlement notice. Deactivation means the plugin **leaves completely** — it stops waiting and injects nothing, so that step belongs entirely to the model |
| ✅ Guaranteed | A deactivation is **always temporary**: the next time the model tries to close the turn, the gate re-engages immediately if descendants remain. There are exactly two ways to deactivate: **a message arrived** or **the silence timer elapsed** |
| ❌ Not guaranteed | That the model produces no intermediate prose — the gate governs the *turn*, not speech |
| ❌ Not blocked | The model interrupting its own subagents (`interrupt_agent`); that is its own judgement, and the interruption produces a settlement notice anyway |
| ⚙️ Optional | Set `releaseOn: ['user','agent-message']` to restore the old "accumulate every settlement notice, then hand them over in one batch" behaviour |

Delivery is never gated by this plugin: messages are spliced into the Agent inbox by the runtime. A subagent messaging a *different* agent does not pass through here at all.

---

## Configuration

The bundle's `cordis.patch.yml` inserts one row; configuration lives on that row.

| Field | Default | Meaning |
|---|---|---|
| `firstWaitMs` | `60000` | How much silence means "time to remind". **Each attempt to close the turn is timed separately**: when it elapses, the plugin injects exactly **one** notice and leaves immediately |
| `nudge` | `true` | Enable the timer path. `false` makes the gate completely silent (it only waits) |
| `pollMs` | `250` | Poll interval. Elapsed wait is measured on the **wall clock**, so probe latency cannot skew it |
| `releaseOn` | `['*']` | `'*'` = any arrival deactivates the plugin. `['user','agent-message']` makes settlement notices accumulate instead |
| `companionReminder` | `false` | Off by default: an arrival deactivates the plugin with nothing added. Set `true` to also inject "this is progress, not the final answer" when a `next-step` arrival is what ended the pause |
| `maxCompanionPerTurn` | `2` | Per-turn cap for that companion reminder |
| `policySection` | `true` | Inject a short rule into the system prompt telling the model to wait for every dispatched subagent |
| `onProbeError` | `'open'` | When the descendant listing cannot be read: `open` releases the turn, `closed` keeps waiting |
| `policyText` / `nudgeText` / `companionText` | built in | Override the wording. Templates support `{n}` (pending count), `{s}` (seconds waited), `{list}` (pending children) |
| `debug` | `false` | Diagnostic logging |

Example override (in a profile patch, a bundle patch, or your own workspace bundle):

```yaml
- id: wait-guard
  config:
    firstWaitMs: 120000
    nudge: false
```

A row patch replaces `config` wholesale — restate every field you still want.

---

## How it works

The gate hangs off `agent/turn-stopping`, the event `dsh-agent-loop` awaits immediately before it re-reads the inbox and decides whether to close the turn:

```js
// dsh-agent-loop: the two checks around the awaited event
if (turnEnds && this.inbox.nextStep.length === 0) {
    await this.dispatch.serial("agent/turn-stopping", { turn, signal });  // ← the gate pauses here
}
if (turnEnds && this.inbox.nextStep.length === 0) break;                  // ← the turn really ends
```

The dispatch is **awaited and serial**, its return value is discarded, and `turnEnds` is not writable from a listener — so the only lever a listener has is the inbox. This plugin simply does not return while work is pending, and then releases; anything it injected keeps the turn alive for one more step.

Inside that await it polls the whole descendant tree (`listDescendants`, filtered by the Agent registry's real `status`), and exits on: an arrival, the silence timer, a quiet subtree, cancellation (`signal.aborted`), or plugin disposal. Pending waits are resolved on disposal, so unloading the plugin can never leave a turn stuck.

---

## Verification

```sh
npm test        # or: node test/self-test.mjs
```

22 tests drive the real plugin against a fake host context: no pending work, single-level and **multi-level** (idle coordinator with a running grandchild) holds, arrival deactivates and injects nothing, deactivation is temporary, opt-in companion, opt-in batching, wall-clock nudge timing under slow probes, one notice per stop attempt, `nudge:false` silence, abort, disposal, fail-open/fail-closed probes, session-format-V4 source admission for every emitted notice, conditional policy section, config fallbacks, and message-id/summary bounds.

Every live behaviour above was also reproduced against a real Harness profile: the gate held a premature answer for 11–61 seconds until the last subagent settled, and the recorded `turn/end` count stayed at zero throughout.

---

## Development notes

- **Host-only bundle**: no dependencies, no build step, no client entry — the implementation is a single import-free module, so nothing resolves at load time.
- **Editing the code while the app runs**: configuration hot-reloads, but module files do not (`dsh-hmr` ships with `root: []`), and the loader reuses the runtime already imported for a row id. Either restart, or add a never-imported entry file plus a new row id and bump the query on its internal import. Do **not** put a query string in a row's `name`: the loader treats it as a filesystem path and the import silently fails.
- Tested against DSH `0.1.7-rc.2` (macOS desktop) and `0.1.5-rc.2` (npm CLI).

## Known limits

1. **A subagent that never settles means the Agent waits.** Reasons to exit: the timer notice gives the model a chance to `interrupt_agent`, the user can stop the turn, or set `nudge: false` for a silent gate.
2. **Each arrival costs one model request** (that is the price of "handle the message now"). Set `releaseOn: ['user','agent-message']` to batch settlements instead.
3. **The gate never rewrites the reason a turn ended** — it only postpones the decision.
4. **Non-continuable one-shot subagents are not covered**: they cannot be resumed and never send settlement notices, so they are invisible to the listing this plugin watches.

## License

MIT
