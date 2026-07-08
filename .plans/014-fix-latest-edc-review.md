# fix latest edc review findings

## objective
Fix all actionable findings from the latest EDC review-all run and produce an issue/fix report.

## status
- [x] read latest security/delivery/quality reports
- [x] identify actionable findings
- [x] add failing regression for invalid ready-job branch reuse
- [x] fix ready-job replacement branch-boundary checks
- [x] verify medium issue cleared by edc quality worker
- [x] remove follow-up dead fixture exports
- [x] remove real-timer timeout test smell
- [x] split oversized fixture/job test files
- [x] reduce duplicated invalidation and `startAsyncJobWithDeps` settlement density
- [x] run verification
- [x] write issue/fix report

## issue/fix report

### security review
- issue: none reported in `review-HEAD.md`.
- fix: none required.

### delivery review
- issue: none reported in `delivery-review-current.md`; implementation was reported as delivered/fitting architecture.
- fix: none required.

### quality issue: ready-job replacement can reuse an invalid branch snapshot
- report source: `edc-context/reports/issues.md` from latest review-all/quality pass.
- risk: a ready async compaction could be reused on an unchanged leaf even when the current branch no longer contained the snapshot boundary needed for safe application.
- exact fix:
  - `src/validation.ts`: extracted `getReadyJobContextInvalidationReason(job, ctx, settings)` as the shared validation policy for session/model/settings/thinking/snapshot/tail-size checks.
  - `src/job.ts`: changed `shouldReplaceReadyJob` to call that shared helper instead of the narrower local logic.
  - `test/job-replacement.test.ts`: added regression coverage for replacing a ready job when the current branch no longer contains its snapshot boundary.

### quality issue: duplicated invalidation logic
- report source: follow-up `edc-context/reports/complexity.md`.
- risk: model/thinking/session-tree invalidation handlers could drift.
- exact fix:
  - `src/index.ts`: added `invalidateActiveJob(ctx, reason)` and routed `model_select`, `thinking_level_select`, and `session_tree` through it.

### quality issue: dead validation export
- report source: follow-up `edc-context/reports/complexity.md`.
- risk: unnecessary public surface.
- exact fix:
  - `src/validation.ts`: made `estimateAfterApply` private.

### quality issue: timeout tests used real timers
- report source: follow-up `edc-context/reports/complexity.md`.
- risk: slow/flaky timeout coverage.
- exact fix:
  - `src/job.ts`: injected `setTimeout`/`clearTimeout` through `StartAsyncJobDependencies`.
  - `test/context-fixtures.ts`: provided timer defaults in `asyncJobDeps`.
  - `test/job-timeout.test.ts`: captures and triggers timeout callbacks directly.

### quality issue: oversized fixture and lifecycle test files
- report source: follow-up `edc-context/reports/complexity.md`.
- risk: dense test support made lifecycle behavior hard to navigate.
- exact fix:
  - split `test/test-fixtures.ts` into `test/entry-fixtures.ts`, `test/context-fixtures.ts`, and `test/parity-fixtures.ts`, leaving `test/test-fixtures.ts` as a small barrel.
  - split deleted monolith `test/job.test.ts` into `test/job-start.test.ts`, `test/job-timeout.test.ts`, `test/job-failure.test.ts`, and `test/job-replacement.test.ts`.

### quality issue: dense `startAsyncJobWithDeps` settlement path
- report source: follow-up `edc-context/reports/complexity.md`.
- risk: pending/timeout/success/failure transitions were harder to review in one blob.
- exact fix:
  - `src/job.ts`: extracted `recordBackgroundFailure`, `recordEmptySummaryFailure`, `storeReadyResult`, `scheduleTimeout`, `getAutomaticStartBlocker`, `markPending`, and `createSnapshot`.

### remaining edc note
- final quality output reports no correctness/security/operational issues and only one low-risk size-concentration note: `src/job.ts` is cohesive but should be split further only if future lifecycle branches grow it.
- edc command caveat: `edc quality-review` still exits 1 when it generates a no-issues `issues.md` without a `##` section; `edc doctor` is ok, and the report content says no concrete issues were surfaced.

## verification
- `bun test` passed: 43 pass, 1 skipped.
- `bun run typecheck` passed.
- `bun run check` passed.
- `PI_RUN_REAL_COMPACTION_PARITY=1 bun test test/pi-parity.test.ts -t "real long edc conversation"` passed.
- `bun pm pack --dry-run` packed 12 expected package files; tests/plans/reports not shipped.
- `edc doctor` passed.
- final EDC quality report: quality risk 2/10, bloat 1/10, dead exports 0, duplicated code 0, test-value risks 0, correctness/security/operational issues 0.
