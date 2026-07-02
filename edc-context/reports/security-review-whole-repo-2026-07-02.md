# Security Review Report

## What Changed
- Target: whole repo / current `main` plus local plan/report artifact changes
- Baseline: `origin/main` (`8d9efca`); no committed source diff against origin
- Files reviewed: source package scope (`src/*.ts`, `package.json`, `README.md`, `ASYNC_COMPACTION_DESIGN.md`) plus EDC context/reports for routing
- Security-relevant files: `src/index.ts`, `src/job.ts`, `src/preparation.ts`, `src/validation.ts`, `src/utils.ts`
- Context loaded: `edc-context/index.md`, `edc-context/manifest.json`, `edc-context/modules/pi-async-prefix-compaction.md`, `edc-context/reports/issues.md`

## Findings

### No security findings
No exploitable or security-relevant issue survived verification in the reviewed scope.

Checked:
- auth/authorization impact: this extension does not implement its own authz/authn surface. Provider credentials are obtained from Pi's `ctx.modelRegistry.getApiKeyAndHeaders()` and passed directly to Pi `compact()` in `src/job.ts:51-59`.
- validation/input boundaries: environment values are bounded/clamped in `src/utils.ts:25-42`; ready compactions are rejected on custom instructions, session/model/settings/thinking drift, result/snapshot boundary mismatch, branch drift, tool-result cut points, and post-apply size in `src/validation.ts:30-70`.
- external calls/subprocess/filesystem: no shell, SQL, template eval, or direct network/fetch sinks in production source. The external model call is delegated to Pi `compact()`.
- secrets: no repo source logs or persists the API key returned by the model registry. Secret scan over repo scope found no production credential literals.
- sensitive state mutation: runtime state is in-memory only. Invalid or stale async compaction falls back to Pi's synchronous compaction path rather than applying uncertain state.
- security history/regression scan: reviewed recent commits and `git log -S` for auth/secret-adjacent strings; no removed security protection or CVE/security-fix regression was found.

## Security Test Confidence
- Behavior tests cover the main defensive gates: custom instructions, missing snapshot leaf, too-large preview, `firstKeptEntryId` mismatch, lifecycle timeout/failure, and other-extension compaction markers.
- The post-apply no-gap invariant is covered with Pi's real `buildSessionContext()`.
- No dedicated secret-leak regression exists, but current production code has no logging path for auth material.

## Blast Radius
- Reachable entrypoints: Pi lifecycle hooks and commands registered in `src/index.ts`.
- Coupled modules: `src/job.ts`, `src/preparation.ts`, `src/validation.ts`, `src/runtime-state.ts`, `src/utils.ts`.
- EDC invariants touched: async compaction is optimization-only; validation failure must fall back to synchronous Pi compaction; pending/ready async metadata must not persist.

## Historical Context
- Commit history reviewed through `8d9efca`; no relevant `security`, `CVE`, auth, validation, or sandboxing protection removal was found.
- Earlier review findings about compaction marker misattribution and boundary mismatch are fixed in current source (`src/index.ts:108-115`, `src/validation.ts:43-45`).

## Limitations
- Static review plus local tests only; no live model provider request was executed during this security pass.
- Pi framework/provider internals were not audited, only this extension's use of their APIs.
- Local machine npm credentials are outside repo scope and were not included in this report.

## Recommendation
APPROVE

Security-only rationale: no exploitable trust-boundary, secret-handling, injection, authorization, or sensitive-state issue was found in the reviewed repo source.
