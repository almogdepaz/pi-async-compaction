# current-pi plugin review fixes

status: implemented; unstaged
scope: plugin only; released Pi APIs (`>=0.80.3 <0.81.0`)

## confirmed findings

- [x] pass resolved request `env` through to Pi `compact()`, matching Pi's own compaction path
- [x] retry ready apply after `agent_end` while Pi is still settling, bounded and job-correlated

## constraints

- do not reference or detect `requestCompactionBeforeNextTurn`
- never apply while active or while queued messages are pending
- stop retries when the job changes, becomes stale, or queued work exists
- preserve existing public behavior and peer range

## verification

- [x] regressions observed red: env argument was `undefined`; no second apply check was scheduled
- [x] regressions green
- [x] `bun test` — 49 passed, 1 skipped
- [x] `bun run typecheck`
- [x] `bun run check`
- [x] `bun pm pack --dry-run`
- [x] `PI_RUN_REAL_COMPACTION_PARITY=1 bun test test/pi-parity.test.ts` — 6 passed
