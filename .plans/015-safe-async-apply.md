# safe async compaction apply

## objective
Prevent ready async compaction application from interrupting an active Pi agent turn, while still applying automatically when the session is safely idle.

## status
- [x] add red tests for busy/pending defer and agent_end apply
- [x] implement safe apply boundary
- [x] verify tests/typecheck/check
- [x] report outcome

## root cause
`src/job.ts` called `ctx.compact()` immediately when the background summary resolved. Pi's `compact()` aborts the current agent operation before compacting, so background completion during an active response/tool loop can stop the ongoing conversation.

## implemented policy
- start async summary early as before.
- when summary becomes ready:
  - apply immediately only if `ctx.isIdle()` and `!ctx.hasPendingMessages()`.
  - otherwise keep it ready and show `async_compaction ready`.
- on `agent_end`, apply a ready summary if safe.
- manual `/compact` and Pi threshold/overflow compaction still use `session_before_compact` handoff.
- manual `/async-compact-now` reuses a ready job only through the same safe apply gate.

## verification
- red tests observed first:
  - `test/job-start.test.ts`: busy/pending ready jobs incorrectly triggered compaction immediately.
  - `test/index.test.ts`: no `agent_end` safe-apply hook existed.
- green verification:
  - `bun test` passed: 47 pass, 1 skipped.
  - `bun run typecheck` passed.
  - `bun run check` passed.
