# apply ready compaction after esc abort idle

## objective
When the user cancels an active Pi agent turn with Escape and an async compaction is already ready, apply it once Pi has actually become idle.

## status
- [x] inspect Pi abort/agent_end lifecycle
- [x] add red regression
- [x] implement deferred agent_end apply
- [x] update docs
- [x] verify tests/typecheck/check

## evidence
Pi agent-core documents that `agent_end` is the final emitted event, but the agent does not become idle until all awaited `agent_end` listeners settle. The previous extension called `applyReadyCompaction()` inside the `agent_end` listener, so `ctx.isIdle()` could still be false after Escape abort. The ready job remained ready but no later event retried apply.

## fix
`src/index.ts` now schedules the `agent_end` apply check with `setTimeout(..., 0)`, letting Pi settle to idle before `applyReadyCompaction()` checks `ctx.isIdle()` and `ctx.hasPendingMessages()`.

## verification
- red regression: `bun test test/index.test.ts -t "aborted agent end"` failed before the fix.
- green gates:
  - `bun test` passed: 48 pass, 1 skipped.
  - `bun run typecheck` passed.
  - `bun run check` passed.
