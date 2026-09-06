# turn-end apply probe

## objective
Determine whether applying an already-ready async compaction via Pi's `ctx.compact()` at `turn_end` preserves queued steering/follow-up behavior or breaks/reorders/strands queued messages.

## status
- [x] inspect Pi event/queue/compact internals relevant to the probe
- [x] build a real-ish repro against Pi `AgentSession` + `Agent` APIs
- [x] run probe for steering queue
- [x] run probe for follow-up queue
- [x] run probe for no queued messages
- [x] decide whether turn-end apply is safe enough to implement

## success criteria checked
- queued message still runs automatically after turn-end apply: **failed**
- queue count clears correctly: **failed**
- transcript order is preserved: partially; queued user enters agent state but receives aborted assistant response
- no abort/error caused by the apply path: **failed**
- `agent_end`/`agent_settled` fires cleanly to session listeners: **failed**

## evidence
Temporary probe used real Pi package APIs:
- `AgentSession`
- `Agent`
- real extension event dispatch
- real `ctx.compact()` binding
- real `session.prompt(..., { streamingBehavior })` queueing
- deterministic fake stream function only at the provider boundary

Results:

### baseline, no queue
- events include `agent_end`
- prompt settles
- pending count is `0`

### turn-end compact, no queue
- events stop at `turn_end`, then `compaction_start`, `compaction_end`
- session listeners do **not** receive `agent_end`
- this happens because `ctx.compact()` calls Pi manual compaction, which `_disconnectFromAgent()` before the low-level run emits `agent_end`

### baseline, steering queue
- queue update adds steering message, then clears it
- second provider call starts with `abortedAtStart: false`
- assistant response completes normally
- `pendingMessageCount` is `0`

### turn-end compact, steering queue
- `turn_end` handler sees `idle: false`, `pending: true`
- `ctx.compact()` is fire-and-forget, but immediately aborts the active run and disconnects session event handling
- queued steering is injected into low-level agent state, but second provider call starts with `abortedAtStart: true`
- assistant response is `stopReason: aborted`
- `pendingMessageCount` remains `1`; queue bookkeeping never observed the queued user message start
- no session-level `agent_end`

### baseline, follow-up queue
- queue update adds follow-up message, then clears it
- second provider call starts with `abortedAtStart: false`
- assistant response completes normally
- `pendingMessageCount` is `0`

### turn-end compact, follow-up queue
- same failure shape as steering
- queued follow-up is injected but receives aborted assistant response
- `pendingMessageCount` remains `1`
- no session-level `agent_end`

## conclusion
Do **not** apply ready async compaction at `turn_end` via public `ctx.compact()`. It breaks Pi queue/session lifecycle. The current safe boundary after `agent_end`/idle is necessary unless Pi adds a non-aborting apply API or an internal pre-queued-message compaction hook.

## next recommended work
Improve the current safe apply path instead:
- bounded retry if `agent_end + setTimeout(0)` still sees non-idle
- add `agent_settled` trigger as another safe retry point
- optionally apply before the next top-level user prompt if Pi exposes a pre-prompt hook that runs while idle
