# Antipattern Scan Report

**Target:** repo source/package/docs (`src/*.ts`, `package.json`, `README.md`, `ASYNC_COMPACTION_DESIGN.md`)
**Mode:** full
**Date:** 2026-07-02
**Scope summary:** 12 files / 2050 LOC scanned (`src/*.ts` includes tests)

---

## Findings

### HIGH severity

No high-severity antipatterns found.

### MEDIUM severity

#### 1. Copy-paste / WET — confidence: HIGH
- **Location:** `src/preparation.ts:L14-L129`, `src/utils.ts:L117-L147`
- **Snippet:**
  ```ts
  function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
    // mirrors Pi compaction utility behavior
  }
  export function estimateContextUsageTokens(messages: readonly AgentMessage[]): number {
  ```
- **Why this matches:** the extension locally mirrors Pi private compaction preparation/file-op/token-accounting behavior. This is duplicated protocol logic, not superficial repeated syntax.
- **Why it might be intentional:** yes; the module context and tests document this as a compatibility clone because Pi does not publicly export `prepareCompaction()` / `estimateContextTokens()`.
- **Suggested fix:** keep the clone narrow and parity-tested; replace it with public Pi exports immediately if they become available.
- **Catalog:** Copy-paste programming / WET (see `/Users/home/.pi/agent/skills/antipattern-scan/CATALOG.md`)

### LOW severity

#### 1. Hard code — confidence: HIGH
- **Location:** `src/index.test.ts:L7-L12`
- **Snippet:**
  ```ts
  import {
    estimateContextTokens as estimatePiContextTokens,
    prepareCompaction as preparePiCompaction,
  } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
  ```
- **Why this matches:** the test suite depends on a private package layout under `node_modules`, not a public package export.
- **Why it might be intentional:** yes; the adjacent comment explains this is a test-only parity sentinel because Pi does not publicly export the functions.
- **Suggested fix:** keep it test-only and commented; switch to public exports when Pi exposes the needed APIs.
- **Catalog:** Hard code (see `CATALOG.md`)

---

## Other observations outside catalog

- `package.json:L46-L50` — peer dependencies now target the tested Pi package family (`>=0.80.3 <0.81.0`); no dependency-conflict antipattern remains.
- `src/job.ts:L128-L253` — `startAsyncJobWithDeps` is a dense lifecycle state-machine orchestrator. It is not large enough or tangled enough to call spaghetti/god-function, and tests cover the important transitions, but future edits should be careful.

## Skipped (triage rules applied)

- `src/constants.ts:L1-L22` — named protocol/status constants, not magic strings.
- `src/utils.ts:L25-L42` — environment reads are documented configuration, not hard-coded runtime secrets.
- `src/index.ts:L53,L129` — `console.log` is intentional non-UI command fallback.
- `src/index.ts:L115` — `setTimeout(..., 0)` is intentional UI notification deferral and covered by behavior test.
- `src/index.test.ts` numeric/token literals — deterministic fixtures, not production magic numbers.
- `src/index.test.ts:L213,L258` — `as unknown as ExtensionContext/API` casts are test harness fakes, not production diagnostic suppression.

---

## Pre-existing (diff mode only)

Not applicable; full scan mode.
