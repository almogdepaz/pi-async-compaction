# Review Report: Async Pi Compaction Extension

Date: 2026-06-30

## Scope

Files reviewed:

- `src/*.ts`
- `ASYNC_COMPACTION_DESIGN.md`
- `README.md`
- `package.json`
- `.plans/*.md`

Review passes requested:

- EDC review: standalone/manual mode. Formal differential mode is limited because this directory is not a git repo.
- Antipattern scan: full mode.
- EDC audit: manual complexity/duplication equivalent. Formal `edc-audit` requires `edc-context/manifest.json`, which is absent.

## Executive Summary

| Severity | Count | Status |
| --- | ---: | --- |
| High | 1 | fixed |
| Medium | 4 | fixed/mitigated |
| Low | 3 | fixed |

Overall risk after fixes: **low-medium**.

Remaining risk is mostly the intentional self-contained mirror of Pi's internal preparation logic because `prepareCompaction()` is not exported by Pi. Drift is mitigated with sentinel tests and package scripts.

## Findings and Status

### High — async-after-async compactions lost cumulative file-operation details

Status: **fixed**.

- original problem: previous async compactions are persisted with `fromHook: true`, so the next async preparation ignored their `readFiles` / `modifiedFiles` details.
- fix: previous hook details are now inherited only when they include this extension's `asyncPrefixCompaction.promptVersion` marker. Other extension compactions remain untrusted.
- coverage: `src/index.test.ts` verifies own async compaction inheritance, Pi-generated inheritance, and foreign hook rejection.

### Medium — local preparation mirrors Pi internals and can drift

Status: **mitigated self-contained**.

- original problem: message extraction, file-op extraction, previous-summary boundary selection, and split-turn prep mirror Pi internals because installed Pi does not export `prepareCompaction()`.
- fix/mitigation: added drift sentinel tests for file-op inheritance and split-turn semantics. `package.json` now exposes `bun run test`, `bun run check`, and `bun run typecheck` for periodic drift checks.
- remaining risk: if Pi changes unexported preparation semantics, these tests must be updated to match the new contract.

### Medium — no test harness for core invariants

Status: **partially fixed**.

- fix: added pure-helper tests covering repeated async compaction details, split-turn prep, valid append-tail apply, custom-instruction fallback, missing snapshot leaf fallback, and too-large preview fallback.
- remaining gap: full event sequencing (`pending -> stale`, `pending -> ready`, `ready -> superseded`) is not integration-tested.

### Medium — module-level mutable async state was race-sensitive

Status: **mitigated**.

- original problem: runtime state was module-level mutable state shared by event handlers and async callbacks.
- fix: mutable fields now live in a `RuntimeState` object created inside the extension factory. Event handlers close over per-extension state, with existing `jobId` guards retained for async completion callbacks.

### Medium — single source file exceeded 500 LOC

Status: **fixed**.

- fix: production code split by real seams:
  - `src/constants.ts`
  - `src/types.ts`
  - `src/utils.ts`
  - `src/preparation.ts`
  - `src/validation.ts`
  - `src/runtime-state.ts`
  - `src/job.ts`
  - `src/index.ts`
- current largest production file: `src/job.ts` at 163 LOC.
- `src/index.ts` is now 83 LOC and only wires extension events/commands.

### Low — hardcoded local paths in docs

Status: **fixed**.

- fix: docs now use `pi install .` and `pi -e .`.

### Low — `Model<any>` type escape

Status: **fixed where owned**.

- fix: local function/test signatures now use `Model<Api>`.
- note: Pi's public extension APIs may still expose `Model<any>` upstream; this repo no longer adds its own avoidable `Model<any>` signatures.

## Verification

Latest verified commands:

```bash
bun run test
bun run check
bun run typecheck
PI_ASYNC_PREFIX_COMPACTION=0 pi -e . --version
```

Observed results:

- `bun run test`: 8 pass, 0 fail.
- `bun run check`: pass.
- `bun run typecheck`: pass.
- Pi load smoke: prints `0.78.1`.

## Formal EDC Limitations

Formal EDC context build/review still cannot run in this directory because it is not a git repository and has no `edc-context/manifest.json`. This report is a standalone/manual review artifact.
