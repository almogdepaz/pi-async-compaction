# Async Compaction Review

## Executive Summary

| Severity | Count |
|----------|-------|
| high | 2 |
| medium | 3 |
| low | 1 |

**overall risk:** medium-high for the stated goal: async compaction should not reduce compaction quality.

**recommendation:** conditional. boundary/apply safety is mostly conservative and should fall back instead of corrupting context, but quality parity with Pi's built-in compaction is not there yet.

## Scope

Reviewed:
- `ASYNC_COMPACTION_DESIGN.md`
- `src/index.ts`
- Pi docs/source: `docs/compaction.md`, `docs/extensions.md`, `examples/extensions/custom-compaction.ts`, exported compaction/session APIs.

Limitations:
- repo is not a git repo, so no differential history/blame was available.
- no EDC context exists.
- no project tests/tsconfig are present.

## Findings

### high: async summaries drop Pi's file-operation continuity

**evidence:** `src/index.ts:405-412` stores only async metadata in `details`; `src/index.ts:223-258` prompt never asks for `<read-files>` / `<modified-files>` sections. Pi's built-in compaction extracts file ops and appends those tags/details; future built-in compactions only inherit file details from non-hook compactions.

**impact:** after an async compaction, structured file context is weaker than normal Pi compaction. This directly conflicts with "not lose quality" because read/modified file lists are one of Pi's explicit continuity mechanisms.

**recommendation:** generate the background result with Pi's own `prepareCompaction()` + `compact()` pipeline, or duplicate its file-op extraction/formatting exactly. Prefer reusing production code.

### high: previous summaries are not merged with Pi's preservation semantics

**evidence:** `src/index.ts:225-258` includes `<previous-summary>` but only asks for a fresh checkpoint. Pi's built-in update prompt explicitly tells the model to preserve existing summary information and merge new messages.

**impact:** repeated async compactions can silently drop old but still-important context even when boundary validation is correct.

**recommendation:** again, reuse `compact(preparation, model, ...)` in the background. If custom prompt stays, copy the built-in update semantics and system prompt, not just the markdown shape.

### medium: ready/stale jobs block replacement jobs until compaction time

**evidence:** `src/index.ts:355` refuses to start when `state.status === "pending" || state.status === "ready"`; invalidation for model/branch mismatch only runs inside `validateReadyJob()` at `session_before_compact`.

**impact:** if the user changes model or branch after a job becomes ready, the ready job is doomed but still blocks a fresh precompute. Pi then reaches compaction and falls back synchronously, which defeats the main latency goal.

**recommendation:** invalidate on `model_select`, `session_tree`, and any session replacement/start lifecycle available. For ready jobs, consider a refresh policy when appended raw tail grows enough that `too_large` is likely.

### medium: fit validation uses env reserve, not Pi's actual compaction settings

**evidence:** `src/index.ts:338` computes `maxAfter` from `ctx.model.contextWindow - getReserveTokens()`. The actual compaction event exposes `event.preparation.settings.reserveTokens`.

**impact:** if env vars drift from Pi settings, the extension can accept a summary that Pi's own reserve policy would reject, or reject useful summaries unnecessarily.

**recommendation:** at apply time, use `event.preparation.settings.reserveTokens`. Long-term, source all thresholds from Pi settings if the extension API exposes them outside compaction events.

### medium: split-turn fallback is safe but leaves a known async gap

**evidence:** design `ASYNC_COMPACTION_DESIGN.md:123-130`; implementation `src/index.ts:191-194` rejects all split turns.

**impact:** correctness-wise this is fine. latency-wise, large single turns are exactly where compaction pain is worst, so async v1 will often fall back to synchronous compaction in those cases.

**recommendation:** acceptable for v1 if documented as a hard limitation. If quality parity matters, reuse Pi's split-turn `compact()` path in background instead of maintaining a separate simplified preparer.

### low: typecheck/package hygiene is incomplete

**evidence:** repo has no `tsconfig.json` or tests. A direct `bunx tsc` could not resolve peer modules locally. Also `Model<unknown>` at `src/index.ts:127`/`261` does not match Pi AI's `Model<TApi extends Api>` shape from installed types; use `Model<any>` or import `Api` and type it correctly.

**impact:** Pi may still load via runtime transpilation, but package maintenance and CI are fragile.

**recommendation:** add a minimal typecheck/test setup using Pi's extension harness or a small fake context around `prepareSnapshot()` / `validateReadyJob()`.

## Positive notes

- using `session_before_compact` and returning a normal `CompactionResult` is the right API fit.
- append-only validation with `snapshotLeafId` + `firstKeptEntryId` containment/order is conservative enough for the prefix/tail model.
- fallback behavior generally prefers default synchronous compaction over applying uncertain async state.

## Suggested target design

1. on `turn_end`, build a snapshot using Pi's `prepareCompaction(branch, settings)` rather than a local clone.
2. run Pi's `compact(preparation, model, auth, signal)` in the background.
3. store the resulting `CompactionResult` plus snapshot ids/model/prompt metadata.
4. on `session_before_compact`, validate branch/model/session/custom instructions, then return the stored result if the preview context fits using `event.preparation.settings.reserveTokens`.
5. invalidate early on model/tree/session events so stale ready jobs do not block fresh precomputes.

That keeps async behavior while minimizing quality drift from built-in compaction.
