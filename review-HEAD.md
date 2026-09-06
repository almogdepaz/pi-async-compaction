# Review: fb590f23c3073afe524df518171092a2f4fdf43c

**Date:** 2026-08-31T16:37:58Z
**HEAD:** fb590f23c3073afe524df518171092a2f4fdf43c
**Modules reviewed:** pi-compaction 

---

## Module: `pi-compaction`

# Security Review Report

## What Changed
- Target: `fb590f23c3073afe524df518171092a2f4fdf43c`
- Baseline: `main`
- Files reviewed: 16
- Security-relevant files: 8 (`.github/workflows/verify.yml`, `package.json`, `bun.lock`, `src/constants.ts`, `src/core.ts`, `src/job.ts`, `src/utils.ts`, docs describing lifecycle/auth behavior)
- Context loaded: `edc-context/index.md`, `edc-context/reports/issues.md`, `edc-context/modules/pi-compaction.md`

Summary of security-relevant changes checked:
- Pi dependency floor/dev pins move to `0.84.3`/`0.84.4` and CI pins the full Pi runtime family (`package.json:73-81`, `.github/workflows/verify.yml:41-47`).
- Ready async compaction apply moves from `agent_end` retry polling to Pi `agent_settled` (`src/core.ts:117-119`).
- Background compaction now forwards resolved base URL, nullable provider headers, header-only auth, environment, and retry policy to Pi compact (`src/job.ts:54-79`).
- Compaction/retry settings are resolved with Pi project-trust state (`src/utils.ts:92-97`), and Pi `max` thinking level is accepted (`src/utils.ts:105-107`).
- Failed extension compactions now clear correlated handoff/autoresume state (`src/core.ts:191-195`, `src/job.ts:201-214`).

## Findings

### No security findings
No exploitable or security-relevant issue was found in the reviewed scope.

Checked:
- auth/authorization impact: provider auth resolution still goes through `ctx.modelRegistry.getApiKeyAndHeaders(model)` immediately before the background `compact()` call, and the new header/baseURL/retry forwarding aligns with Pi 0.84.4 compact/auth behavior (`src/job.ts:54-79`).
- validation/input boundaries: ready-job handoff still revalidates session/model/settings/thinking/branch/custom-instruction constraints before returning a compaction to Pi (`src/core.ts:133-168`, `src/validation.ts:72-80`).
- external calls/subprocess/filesystem: the only new runtime external-call effect is Pi-managed retry policy for the existing provider summarization call; retry settings are trust-aware (`src/utils.ts:92-97`) and covered by retry/abort tests (`test/compaction-retry.integration.test.ts:61-86`).
- sensitive state mutation: apply failure handling is limited to an in-flight/last-handed-off correlation and clears terminal handoff/autoresume fields (`src/job.ts:201-214`); successful auto-resume remains gated by marker correlation and pending-message check (`src/core.ts:170-188`).
- security history/regression scan: reviewed prior fix commits touching apply reliability, correlation, validation, trust/auth/header behavior; no removed protection was reintroduced as an exploitable path.

Limitations:
- Review was scoped to the listed files plus focused Pi 0.84.4 type/runtime references needed to verify `agent_settled`, compaction failure, and `compact()` API semantics.
- Tests were reviewed as security-confidence evidence but not executed in this review pass.

## Security Test Confidence
- Positive coverage exists for trust-aware settings (`test/utils.test.ts:12-43`), resolved/nullable/header-only provider auth and base URL forwarding (`test/job-start.test.ts:66-165`), retry and abort behavior (`test/compaction-retry.integration.test.ts:61-86`), apply failure cleanup (`test/core.test.ts:81-141`), and real AgentSession auto-resume exactly once (`test/agent-session-compaction.integration.test.ts:29-196`).
- No missing security regression test was identified for the changed trust boundaries.
- Known EDC issues were cross-checked: the `max` thinking-level change reduces snapshot drift risk; duplicated correlation helper logic remains a known low fragility but this diff did not create a concrete security bypass.

## Blast Radius
- Reachable entrypoints: Pi extension hooks `turn_end`, `agent_settled`, `session_before_compact`, `session_compact`, `session_compact_failed`, and command `/async-compact-now` via `src/index.ts:11-15`.
- Affected modules: single-module repo; async compaction lifecycle, provider/auth bridge, retry settings, CI/dependency compatibility.
- EDC invariants touched: Pi remains durable persistence/apply authority; ready jobs remain bound to session/model/thinking/settings/branch; custom `/compact <instructions>` falls back to Pi synchronous compaction; provider/auth forwarding preserves Pi semantics.

## Historical Context
- `git log -S` and grep-history checks covered removed API-key guard, removed `scheduleReadyCompactionApply`, `SettingsManager.create(ctx.cwd...)`, and prior `fix`/review commits in `src/core.ts`, `src/job.ts`, and `src/utils.ts`.
- The removed `agent_end` retry loop is replaced by Pi 0.84.4 `agent_settled`, which is documented in Pi types as firing after the run has fully settled.
- No relevant `security`/`CVE` commit regression was identified.

## Limitations
- Did not audit full provider SDK implementations or all Pi internals beyond focused lifecycle/auth API references.
- Did not review unlisted source except focused reachability/context checks.
- No dynamic test execution was performed.

## Recommendation
APPROVE — no exploitable security regression was found in the scoped diff.

---

