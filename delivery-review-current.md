# Delivery / Architecture Review

## Summary
**Delivery verdict:** delivered  
**Architecture fit:** fits

## Review Calibration
- real goal: Ship a Pi extension that precomputes Pi-compatible compaction summaries in the background, then safely hands a validated `CompactionResult` to Pi's normal compaction flow.
- done evidence: The implementation registers the extension entrypoint and `/async-compact-now`, starts jobs from `turn_end`, uses Pi `compact()`, records snapshot metadata, validates on `session_before_compact`, preserves raw-tail continuity, and passes the default, typecheck, syntax, package dry-run, and opt-in parity gates.
- not the goal: External release side effects such as GitHub visibility changes, npm publish, and npm install verification remain explicitly outside this repo-state delivery review.
- non-obvious invariants: Ready jobs are valid only for matching session/model/thinking/settings/first-kept/snapshot-leaf state; pending/ready state is intentionally in-memory only; Pi compaction settings are the source of truth for reserve/keep-recent tokens; there is no separate status command; local Pi preparation mirrors are acceptable only with parity sentinels.

## Goal / Spec Delivery

| Requirement | Evidence in implementation | Status |
|---|---|---|
| `.plans/001-reuse-pi-compaction.md:6` — "make async compaction use Pi's built-in compaction generation... while applying only if the current branch can safely append the raw tail" | `src/job.ts:44-60` calls Pi `compact()`; `src/index.ts:70-94` hands off through `session_before_compact`; `src/validation.ts:25-74` validates branch/tail fit. | delivered |
| `ASYNC_COMPACTION_DESIGN.md:15-17` — move the model call earlier and reuse Pi `compact()` for quality parity | `src/index.ts:45-47` starts after `turn_end`; `src/job.ts:209-251` resolves the async result, marks ready, and triggers `ctx.compact()`. | delivered |
| `ASYNC_COMPACTION_DESIGN.md:67-81` — record snapshot fields and preserve Pi compaction details under top-level details | `src/job.ts:185-194` records snapshot metadata; `src/job.ts:228-248` preserves existing details and nests `asyncPrefixCompaction`. | delivered |
| `ASYNC_COMPACTION_DESIGN.md:115-131` — reject custom instructions, drift, missing branch nodes, tool-result first-kept, and too-large previews | `src/validation.ts:30-70` implements these checks using event settings for fit. | delivered |
| `ASYNC_COMPACTION_DESIGN.md:133-139` — status clears on ready/failure/invalidation/handoff/timeout and pending jobs are not replaced | `src/job.ts:151-181`, `src/job.ts:200-267`, and `src/index.ts:49-109` implement pending behavior and status clearing. | delivered |
| `.plans/008-fix-review-findings-2026-07-02.md:45-51` — manual `/async-compact-now` reports non-started outcomes, while happy path stays silent | `src/index.ts:24-37` formats outcomes and `src/index.ts:112-118` notifies only when a message exists; tests at `test/index.test.ts:28-68`. | delivered |
| `.plans/012-remove-status-command.md:3-16` — remove `/async-compact-status` while keeping CLI status-line behavior | Only `async-compact-now` is registered in `src/index.ts:112-119`; regression at `test/index.test.ts:21-26`. | delivered |
| `.plans/013-release-hardening-cleanup.md:3-16` — split tests mechanically and remove dead `lastAppliedJobId` state without refactoring `startAsyncJobWithDeps` | Tests are split across `test/*.test.ts`; runtime state contains `lastHandedOffJobId` but no `lastAppliedJobId` at `src/runtime-state.ts:4-14`; `startAsyncJobWithDeps` remains in `src/job.ts:127-270`. | delivered |
| `.plans/007-public-release-prep.md:23-25` — peer range targets Pi `>=0.80.3 <0.81.0`, tarball excludes local artifacts | `package.json:28-49` declares files allowlist and peer ranges; `bun pm pack --dry-run` packed only 12 source/doc/license files. | delivered |

### Findings

No material Goal / Spec Delivery findings.

## Architecture Fit

### Findings

No material Architecture Fit findings.

Context verification:
- EDC manifest is fresh for `527d203817581a10b8fe7963b6f09d28c3c38131` (`edc-context/manifest.json:72-84`) and routes all runtime/docs/tests/package paths to `pi-async-prefix-compaction` (`edc-context/manifest.json:16-37`).
- The implementation follows the documented flow: per-extension state and command in `src/index.ts`, job lifecycle in `src/job.ts`, preparation in `src/preparation.ts`, validation in `src/validation.ts` (`edc-context/modules/pi-async-prefix-compaction.md:12-18`).
- It preserves documented invariants for one in-memory job, validation before handoff, event-settings fit checks, async metadata nesting, status cleanup, empty-summary failure, and post-handoff apply-error recording (`edc-context/modules/pi-async-prefix-compaction.md:20-30`).
- The preparation mirror is contained in the owner module and backed by parity tests as required (`edc-context/modules/pi-async-prefix-compaction.md:32-38`, `test/pi-parity.test.ts:22-97`).

## Integration / Rollout Notes
- Checked docs/config/package/generated artifacts: README env/use docs, design doc, package entrypoint/files/peer dependencies, long-session fixture parity, and EDC context freshness.
- Verification run: `bun test` (42 pass, 1 skipped), `bun run typecheck`, `bun run check`, `PI_RUN_REAL_COMPACTION_PARITY=1 bun test test/pi-parity.test.ts` (6 pass), and `bun pm pack --dry-run` (12 files, source/docs/license only).
- Known accepted rollout gap: `.plans/010-review-artifact-closure.md:82-88` leaves npm publish, GitHub public visibility, and npm install verification as external side effects requiring explicit approval.

## Limitations
- No issue/PR reference was found in the branch or recent commit messages; requirements were taken from repo-local design/docs/plans.
- `.plans/008` contains a superseded status-command detail; `.plans/012` and the EDC context establish that there is intentionally no separate status command.
- Working tree status before writing this report included untracked local review/context/planning artifacts; source, tests, git state, plans, and edc-context were not mutated for this review.
