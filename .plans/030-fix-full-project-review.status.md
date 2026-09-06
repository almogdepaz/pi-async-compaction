# fix full-project review status

- plan: `.plans/030-fix-full-project-review.md`
- plan sha-256: `e31030f1d1c946d91b12991ea4d6ac689a08b3898bc98332c12f5e793366c15d`
- source review: `.plans/001-project-review.md`
- baseline: `43234dc`
- overall state: `accepted`
- current phase: complete

## task states

| task | state |
| --- | --- |
| 1. make adapter ownership explicit | accepted |
| 2. make application and resume lifecycle race-safe | accepted |
| 3. restore current Pi and dependency compatibility | accepted |
| 4. repair release, automation, tests, docs, and observability | accepted |
| 5. verify and independently review the combined result | accepted |

## role sessions

- implementer: `terra-fix-implementer` (`96ee9f85-4402-402d-935f-bd310d55b379`), all tasks completed, independently verified, acknowledged, closed; `SESSION_NOT_FOUND` confirmed
- reviewer: `terra-fix-reviewer` (`1f225495-c2c1-4ee9-a1ec-0eb53be54a15`), final waiver re-review `019fe332-54b9-724a-8dc0-9b5a3b2d5066` clean, independently verified, acknowledged, closed; `SESSION_NOT_FOUND` confirmed

## implementation ledger

| key | finding | state |
| --- | --- | --- |
| ownership | adapter instances are not isolated or correctly attributed | accepted |
| apply | ready application is not idempotent | accepted |
| resume | forced auto-resume does not re-check queued user work | accepted |
| compatibility | current Pi releases are unsupported | accepted |
| supply-chain | dependency audit is not clean | accepted |
| release | release metadata is inconsistent | accepted |
| automation | CI/release gates are absent | accepted |
| test-gaps | critical branches lack direct tests | accepted |
| edc-freshness | generated EDC guidance is stale | waived |
| observability | performance and cost claims are not measured | accepted |

## verification

- baseline review evidence is recorded in `.plans/001-project-review.md`.
- red: `bun test test/adapter.test.ts test/core.test.ts test/job-start.test.ts test/index.test.ts` — 8 failures, each at the intended missing ownership, correlation, apply-claim, duplicate/unsafe id, prompt-version, or queued-resume behavior.
- green: `bun test test/adapter.test.ts test/core.test.ts test/job-start.test.ts test/index.test.ts` — 31 pass, 0 fail.
- green: `bun test` — 59 pass, 1 opt-in parity skip, 0 fail.
- green: `bun run typecheck` and `bun run check` — both pass.
- `git diff --check` passes.
- red: `bun test test/job-start.test.ts` with Pi 0.84.1 before normalization — 1 failure: `x-removed: null` reached `compactFn`.
- green: `bun test test/job-start.test.ts` after normalization — 15 pass, 0 fail.
- green, Pi 0.84.1: `bun test` — 60 pass, 1 opt-in parity skip, 0 fail; `bun run typecheck`, `bun run check`, and `PI_RUN_REAL_COMPACTION_PARITY=1 bun test test/pi-parity.test.ts` — all pass (6 real-parity tests).
- green, Pi 0.80.3 temporary copy: `bun run typecheck` and `bun test` — typecheck passed; 60 pass, 1 opt-in parity skip, 0 fail.
- fresh current-Pi `bun audit` — no vulnerabilities found after `brace-expansion@5.0.9` and `protobufjs@7.6.5` overrides.
- task 4 red: lifecycle-observer expectations in `test/core.test.ts` failed before the observer API and emission points existed; diagnostics tests now cover handoff, failure, invalidation, and observer isolation.
- task 4 green: `bun install --frozen-lockfile`; `bun test` — 70 pass, 1 opt-in parity skip; `bun test --coverage` — 70 pass, 1 skip, 94.69% functions / 94.45% lines; `bun run typecheck`; `bun run check`; `PI_RUN_REAL_COMPACTION_PARITY=1 bun test test/pi-parity.test.ts` — 6 pass; `bun audit` — no vulnerabilities; `bun run release:check`; `bun pm pack --dry-run`; and `git diff --check` all passed.
- task 4 correction red: `bun test test/release-consistency.test.ts test/edc-freshness.test.ts test/readme-notification.test.ts` failed before the pure release/EDC checks and notification documentation existed.
- task 4 correction green: focused checks — 7 pass; `bun test` — 77 pass, 1 opt-in parity skip; `bun run typecheck`, `bun run check`, `bun run release:check`, `bun pm pack --dry-run`, and `git diff --check` passed.
- `bun run edc:check` now intentionally fails for the correct reason: manifest source `527d203817581a10b8fe7963b6f09d28c3c38131` is an ancestor, but routed source files changed since it. The pure EDC test confirms later context-only regeneration passes while routed source changes fail; canonical EDC refresh remains deferred.
- EDC checker hardening red: empty/missing modules and malformed match/routes expectations failed open before routing-shape validation. Green: `bun test test/edc-freshness.test.ts` — 8 pass; `bun test` — 82 pass, 1 opt-in parity skip; `bun run typecheck`, `bun run check`, `bun run release:check`, and `git diff --check` passed.
- canonical refresh attempt 1 failed because no model was configured.
- attempts 2–3 with explicit models timed out at 1,800 seconds; direct reproduction found the global `pi-cursor-provider` extension emits stale-context/agent-already-processing errors and prevents `agent_end`.
- isolated `PI_CODING_AGENT_DIR` plus the existing auth symlink fixed the subprocess hang, but canonical `edc update --base 43234dc` correctly ignored all uncommitted changes because its contract is `git diff <base>..HEAD`; manifest remained at `527d203` and doctor/freshness still fail.
- the immutable plan simultaneously forbade commits and required commit-provenanced canonical EDC refresh; user explicitly authorized one local source commit to resolve the conflict.
- local source commit `cd4acb8ef7c69ad70be51d548d621f00c2223d9d` contains only the reviewed 35 product/CI/docs/test paths; no generated EDC, plans, review reports, AGENTS, or unrelated files were committed or staged.
- canonical EDC refresh with isolated Pi config now records source commit `cd4acb8`, reports 39 context-mapped / 35 contextless / 0 uncovered / 0 ambiguous paths, and passes `edc doctor` plus `bun run edc:check`.
- fresh post-commit verification: 82 tests pass with 1 opt-in skip; coverage 95.36% functions / 94.10% lines; strict typecheck, syntax, 6 real parity tests, audit, release check, package dry-run (20 files / 128.28 KB), EDC doctor/freshness, diff checks, clean index, and sourceCommit equality all pass.
- minimum Pi 0.80.3 clean archive matrix: strict typecheck, 82 tests with 1 opt-in skip, and 6 real parity tests pass.
- final reviewer found one blocker and parent reproduced it from `git archive HEAD`: committed CI calls `bun run edc:check`, but `edc-context/manifest.json` is intentionally untracked, so clean checkout exits 1 with ENOENT.
- user explicitly waived EDC; final correction `d378185a994fadc60e25b0f0281d7eecee677296` removes the EDC package/CI integration rather than committing incomplete generated context or fabricating routing.
- final current-head verification: 74 tests pass with 1 opt-in skip; coverage 95.05% functions / 93.80% lines; strict typecheck, syntax, 6 real parity tests, clean audit, release consistency, package dry-run (20 files / 128.20 KB), diff/index checks all pass.
- final clean-archive Pi 0.80.3 matrix: strict typecheck, 74 tests with 1 opt-in skip, and 6 real parity tests pass; no committed EDC integration references remain.
- final independent reviewer found no concrete blocker or regression under the explicit EDC waiver.

## changed files

- production: `src/adapter.ts`, `src/constants.ts`, `src/core.ts`, `src/diagnostics.ts`, `src/job.ts`, `src/runtime-state.ts`, `src/types.ts`, `src/utils.ts`.
- package/release/automation: `package.json`, `bun.lock`, `CHANGELOG.md`, `scripts/release-consistency.ts`, `scripts/check-release.ts`, `.github/workflows/verify.yml`.
- docs: `README.md`, `ASYNC_COMPACTION_DESIGN.md`, `docs/async-compaction-adapters.md`.
- tests/fixtures: `test/adapter.test.ts`, `test/configuration.test.ts`, `test/context-fixtures.ts`, `test/core.test.ts`, `test/index.test.ts`, `test/job-failure.test.ts`, `test/job-replacement.test.ts`, `test/job-start.test.ts`, `test/job-timeout.test.ts`, `test/readme-notification.test.ts`, `test/release-consistency.test.ts`, `test/validation.test.ts`.

## constraints and decisions

- user explicitly authorized one local source commit to satisfy EDC provenance; no push, tag, publish, merge, or branch change.
- preserve unrelated working-tree content.
- production behavior fixes use test-first red/green evidence.
- generated EDC context must be refreshed with canonical tooling, not manually rewritten.

## next action

none; accepted result reported to the user.
