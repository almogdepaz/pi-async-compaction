# fix all verified full-project review findings

source: `.plans/001-project-review.md`  
target baseline: `main` at `43234dc`

goal: resolve every verified actionable finding from the full-project review while preserving Pi-compatible compaction behavior, unrelated working-tree content, and the package's intentionally small architecture.

## 1. make adapter ownership explicit

- namespace runtime status and job ids by adapter id.
- persist adapter id and the adapter-provided prompt version in the structured compaction marker.
- accept and notify/auto-resume only markers owned by the current registration.
- reject unsafe adapter ids or duplicate registrations when registration evidence makes that deterministically possible.
- use the adapter label for user-visible status/notification text.
- add failing multi-adapter, marker-version, status, and ownership regressions before production changes.

## 2. make application and resume lifecycle race-safe

- atomically claim a ready job before triggering Pi compaction so repeated application attempts cannot trigger duplicate compactions.
- preserve safe validation, fallback, apply-error handling, and active-turn force behavior.
- re-check pending user messages before sending the synthetic auto-resume prompt.
- add failing duplicate-apply and queued-message auto-resume regressions before production changes.

## 3. restore current Pi and dependency compatibility

- update the Pi development dependencies from the old 0.80.3 baseline to the current supported release.
- widen peer ranges only across versions verified by the compatibility matrix.
- normalize provider headers at the typed Pi boundary without weakening types.
- refresh the lockfile and remove all dependency advisories that can be resolved from this package; document any upstream-only remainder with exact evidence.
- add or retain tests for header normalization and run minimum/current Pi compatibility checks.

## 4. repair release, automation, tests, docs, and observability

- assign a new unreleased package version and add complete changelog coverage for all post-0.1.6 behavior and review fixes.
- replace the stale git-install tag and update tested-Pi/version claims.
- add minimal CI gates for tests, typecheck, syntax, package dry-run, real parity, dependency audit, release metadata, and the supported Pi matrix.
- add direct behavior tests for the review's missing invalidation and environment/configuration branches.
- add opt-in structured lifecycle diagnostics sufficient to measure starts, ready results, handoffs, invalidations/failures, durations, and wasted work; document cost tradeoffs and measurement use.
- refresh generated EDC context through its canonical tooling after source fixes; do not hand-edit generated routing merely to change its recorded commit.

## 5. verify and independently review the combined result

- run focused red/green regressions for every behavior fix.
- run the full suite, strict typecheck, syntax check, coverage, realistic parity, package dry-run, audit, and supported Pi compatibility matrix.
- check release metadata consistency and packed contents.
- have a separate read-only Terra reviewer inspect delivery, security, maintainability, test value, and antipattern risk against this immutable plan.
- correct only verified regressions introduced by this work, then repeat relevant verification.

## non-goals

- do not publish npm, create a git tag, commit, push, merge, or change branches.
- do not redesign Pi's compaction protocol or replace the built-in summary generator.
- do not add a build system, formatter, telemetry service, runtime dependency, or paid benchmark.
- do not modify or remove unrelated pre-existing tracked or untracked working-tree content.
