# auto-resume after force compaction

status: verified

## goal
when this extension aborts an active turn to apply a ready async compaction over the async threshold, automatically kick the agent after the extension-provided compaction is persisted.

## assumptions
- resume only applies to the force-abort path introduced in `.plans/026-force-stop-over-threshold.md`.
- resume happens after `session_compact` confirms Pi persisted this extension's compaction.
- use Pi's public extension API to send a user message because no public `continue()` API exists on `ExtensionContext`/`ExtensionAPI`.

## tasks
- [x] add regression test for abort -> async compaction -> auto-resume
  - red: `bun test test/index.test.ts -t "auto-resumes after a force-stopped async compaction is applied"` failed with no sent resume message
- [x] add state marker for force-aborted handoff
- [x] send a single resume message after matching `session_compact`
  - green: `bun test test/index.test.ts -t "auto-resumes after a force-stopped async compaction is applied"`
- [x] update docs
- [x] verify narrow + full suites
  - green: `bun test test/index.test.ts` (12 pass)
  - green: `bun test test/job-start.test.ts` (12 pass)
  - green: `bun test` (54 pass, 1 skip)
  - green: `bun run typecheck`
  - green: `bun run check`
