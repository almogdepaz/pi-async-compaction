# Security Review Report

## What Changed
- target: stable Pi 1.x compatibility release; baseline `v0.1.8` / `5b9a70b`.
- security-relevant production paths: `src/job.ts`, `src/preparation.ts`, `src/utils.ts`, `src/validation.ts`, `src/constants.ts`; reviewed adjacent adapter/core lifecycle, changed tests, dependency metadata and CI.
- no EDC context exists in this repository; baseline comes from source, git history and current Pi's public implementation.

## Findings

### No security findings
no exploitable or security-relevant issue survived verification in the reviewed changes.

checked:
- authentication: failed `getApiKeyAndHeaders` still stops dispatch; successful keyless native auth delegates streaming to the session registry, not a global provider registry. real native-provider tests verify both success and rejected credentials with zero dispatch on failure.
- context boundary: retained context edits prevent raw-history preparation and invalidate pre-edit summaries before handoff. real AgentSession fallback excludes omitted text and includes replacements. existing session/model/settings/leaf/size validation remains.
- project trust: per-model compaction settings use Pi's trust-aware resolver; coverage verifies untrusted project overrides do not replace global settings.
- file operations: nested tool metadata contributes only file names to summary metadata, not filesystem operations or execution.
- external calls: the change uses the current session's provider runtime; no production subprocess, executable input or new filesystem sink.
- dependency gate: initial audit failed on historical `brace-expansion@5.0.9`; updating to the host's `5.0.12` pin eliminated all three reported advisories. final audit found zero vulnerabilities.

## Security Test Confidence
- real native runtime/provider covers keyless auth success, credential rejection, retries and abort during backoff.
- unit regressions cover omitted/replaced context, stale summary rejection, and async eligibility after compaction passes the edits.
- real AgentSession integration covers projected native fallback and existing abort/apply/resume behavior.
- per-model settings regression retains the untrusted project boundary.
- final full suite: 100 tests and 268 assertions on each of Pi 1.3.0, 1.4.0 and 1.5.0; all passed. packed Node smoke uses the real extension loader and persists a real hook-provided compaction on each host.

## Blast Radius
built-in async summarization reaches provider auth/transport through `buildAsyncCompactionResult`. shared lifecycle validation governs ready-summary persistence. no adapter API change; edited contexts conservatively defer to synchronous native compaction.

## Historical Context
`dc0c8a1` added resolved auth/header/environment and retry forwarding. those fields remain. the removed condition incorrectly assumed every successful native authentication returned a string key or headers. current Pi's native provider runtime owns authentication; explicit failed resolution still stops dispatch. original project-trust, stale-result and correlated-persistence protections remain.

## Limitations
self-review only; user disallows additional sessions. synthetic transports verify host contracts, not live provider entitlement or every external backend. no independent audit of Pi or its dependencies beyond scoped contract inspection and package audit. remote CI/publication are separate release gates, not security-review completion evidence.

## Recommendation
APPROVE within the reviewed security scope. evidence and remaining release gates: `.plans/pi-1.x-release.md`; private logs under `/tmp/pi-compat-release.QbHJFb`.
