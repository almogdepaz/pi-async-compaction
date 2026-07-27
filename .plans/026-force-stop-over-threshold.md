# force-stop over async threshold

status: verified

## goal
when a ready async compaction exists and current context usage is over the async threshold, force-stop the active agent and trigger pi compaction, matching normal manual compaction semantics: abort first, compact, no automatic resume.

## assumptions
- threshold uses the existing async start ratio (`PI_ASYNC_PREFIX_COMPACTION_START_RATIO`, default 0.8).
- force-stop only applies to ready async results, not pending jobs.
- no auto-resume after abort.

## tasks
- [x] add regression test for over-threshold active agent abort + compaction trigger
  - red: `bun test test/job-start.test.ts -t "force-stops the active agent before applying a ready job over the async threshold"` failed with `Expected: true, Received: false`
- [x] implement minimal job apply behavior
- [x] run narrow + broad verification
  - green: `bun test test/job-start.test.ts -t "force-stops the active agent before applying a ready job over the async threshold"`
  - green: `bun test test/job-start.test.ts` (12 pass)
  - green: `bun test` (53 pass, 1 skip)
  - green: `bun run typecheck`
  - green: `bun run check`
