# final spot re-review: compaction backend comparison

scope: immediate-cancellation launch correction only. static, read-only review; no tests run.

## no current findings

The immediate-cancellation launch defect is resolved:

- `src/comparison.ts:53-56` now checks `signal.aborted` inside the deferred microtask before invoking `run`. An abort between listener registration and that microtask therefore throws the classified abort error without calling either backend.
- `test/backend-comparison.test.ts:135-153` aborts immediately after `runCompactionBackendComparison()` returns, verifies both sides classify as `cancelled`, and asserts `providerCalls` and `webCalls` remain zero.
- the new thrown abort error is consumed by the attached rejection branch at `src/comparison.ts:53-56`; if the abort listener already settled the wrapper, `settle` is idempotent (`src/comparison.ts:43-50`). No new unhandled-rejection path or launch/abort race was verified by static inspection.
- an abort after a runner has passed the pre-launch check retains the existing behavior: the runner receives the shared aborted signal, the wrapper settles once, and its later fulfillment/rejection is consumed by the same attached handler.

## verification

review artifact exists and `git diff --check -- .plans/036-compaction-backend-comparison.review.md` passed. no code/tests/docs were edited; no tests, agents, commits, or pushes were run.
