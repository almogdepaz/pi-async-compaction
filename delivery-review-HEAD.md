# Delivery / Architecture Review

## Summary
**Delivery verdict:** partially delivered  
**Architecture fit:** questionable

## Review Calibration
- real goal: Close the approved phase-2 Pi 0.84 lifecycle modernization by raising the compatibility floor, forwarding retry settings, replacing `agent_end` polling with `agent_settled`, handling passive compaction failures, and adding real lifecycle coverage.
- done evidence: Peer/dev/CI/docs target Pi `0.84.3`-`0.84.4`; background `compact()` receives effective retry settings; ready application is wired to `agent_settled`; `session_compact_failed` produces one terminal failure for the relevant handoff; focused retry, failure, parity, and real `AgentSession` tests cover the new behavior.
- not the goal: Provider benchmark/telemetry work, promotional adoption evidence, releasing/publishing, replacing Pi's private preparation mirror, or adding a new upstream queued-message compaction API.
- non-obvious invariants: Pi remains the persistence/apply authority; async state is in-memory only; ready jobs are valid only for the same session/model/thinking/settings/branch; correlation is adapterId + jobId + promptVersion; custom `/compact <instructions>` must fall back to Pi synchronous compaction; provider/auth forwarding must preserve Pi-compatible base URL, headers, env, and retry behavior.

## Goal / Spec Delivery

| Requirement | Evidence in implementation | Status |
|---|---|---|
| `.plans/033-audit-findings-remediation.md:43` — “raise the peer, CI, and documentation minimum to Pi `0.84.3` while retaining `0.84.4` as current.” | `package.json:74-81`, `.github/workflows/verify.yml:32`, `README.md:204` | delivered |
| `.plans/033-audit-findings-remediation.md:44` — “forward the effective Pi retry policy into background compaction.” | `src/job.ts:52-78`, `src/utils.ts:96-97`, `test/job-start.test.ts:66-72` | delivered |
| `.plans/033-audit-findings-remediation.md:45` — “add transient retry/abort regressions.” | `test/compaction-retry.integration.test.ts:57-112` | delivered |
| `.plans/033-audit-findings-remediation.md:46` — “replace bounded `agent_end` polling with `agent_settled` and focused ordering regressions.” | `src/core.ts:117-119`, `src/constants.ts` removed retry constants, `test/index.test.ts` verifies no `agent_end` handler | delivered |
| `.plans/033-audit-findings-remediation.md:47` — “correlate `session_compact_failed` only to this adapter's passive handoff; clear terminal state and emit one failure.” | `src/core.ts:191-194` handles failures when `event.fromExtension` and `state.lastHandedOff` are present; see finding below for adapter attribution gap | partial |
| `.plans/033-audit-findings-remediation.md:48` — “add actual `AgentSession` integration coverage for abort → persisted compaction → exactly one resume.” | `test/agent-session-compaction.integration.test.ts:29-190` | delivered |
| `.plans/033-audit-findings-remediation.md:21` — preserve resolved auth/baseUrl/header-only/null-header behavior and reject no auth material. | `src/job.ts:54-78`, `test/job-start.test.ts:74-171` | delivered |
| Prior audit requirement for `max` thinking reconstruction/marker acceptance (`.plans/032-independent-review.md:15`) | `src/utils.ts:100-106`, `test/utils.test.ts:53-72` | delivered |

### Findings

#### IMPORTANT — `session_compact_failed` is not attributable to a specific async adapter once another compact handler can win
- category: partial requirement
- requirement: `.plans/033-audit-findings-remediation.md:47` — “correlate `session_compact_failed` only to this adapter's passive handoff; clear terminal state and emit one failure.”
- implementation evidence: `src/core.ts:154-159` records `state.lastHandedOff` as soon as this handler returns a ready compaction, while `src/core.ts:191-194` later treats any `session_compact_failed` with `event.fromExtension` as that handoff. Pi's failed event only exposes `fromExtension`, not marker/job details (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:464-475`), and Pi's runner keeps iterating `session_before_*` handlers with the last non-cancel result winning (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:633-652`).
- why it matters: If a later `session_before_compact` handler from another async adapter or compaction extension returns a different compaction, this adapter's `lastHandedOff` remains set even though its compaction was not the final one Pi attempted. A subsequent extension-provided compaction failure can therefore mark this adapter/job failed and emit a misleading lifecycle failure, violating the “only to this adapter” part of the requirement and the adapter-scoped correlation invariant.
- action: STANDARDIZE_CONTRACT
- recommendation: Either add shared handoff ownership/arbitration for registered async adapters and clear superseded handoffs when another extension result wins, or narrow/document the failure-attribution contract until Pi exposes marker/job details on `session_compact_failed`. Keep success/failure cleanup symmetrical so a foreign extension result cannot leave stale `lastHandedOff` state behind.

## Architecture Fit

### Findings

#### IMPORTANT — Failure attribution crosses the adapter boundary by relying on Pi's coarse `fromExtension` flag
- category: API/error contract
- architecture source: `edc-context/index.md` critical invariant: “Correlation must match `adapterId`, `jobId`, and `promptVersion`; ignore foreign-extension, non-extension, or stale-marker compactions.” `edc-context/modules/pi-compaction.md` also states that provider/auth failures, compaction failures, timeout aborts, and apply errors are contained to correlated job state.
- implementation evidence: `src/core.ts:191-194` has no adapter/job/prompt check beyond the local `lastHandedOff`; Pi's `SessionCompactFailedEvent` has no compaction marker/details field (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:464-475`).
- why it matters: The new handler is in the right owning module, but it standardizes on a boundary event that lacks the correlation data this module's public adapter contract depends on. That makes failure diagnostics adapter-scoped only in the single-winning-handler case and questionable when multiple compaction extensions are installed.
- action: STANDARDIZE_CONTRACT
- recommendation: Treat `session_compact_failed` as a coarse Pi boundary until it carries marker details: use an explicit owner token for this package's own handlers where possible, clear stale handoff state on observed foreign successes, and avoid promising adapter-exact failure attribution for foreign extension races without upstream support.

## Integration / Rollout Notes
- Checked diff summary, changed files, commit log, EDC context/index/module/issues, local plans/specs, Pi extension/compaction type contracts, and changed source/tests/docs/config.
- Focused verification run completed: `bun test test/utils.test.ts test/job-start.test.ts test/index.test.ts test/core.test.ts test/compaction-retry.integration.test.ts test/agent-session-compaction.integration.test.ts` — 44 pass, 0 fail.
- CI matrix now pins Pi `0.84.3` and `0.84.4` and runs explicit real compaction parity in both matrix jobs.
- No migrations or generated artifacts were required for this package change.

## Limitations
- No PR text or external issue tracker was available; repo-local plans `.plans/033-*` and referenced audit plans were used as the spec source.
- I did not run the full repository verification gate or temporary clean Pi `0.84.3` install; I relied on the focused local run plus changed CI metadata and plan evidence.
