# 028 async compaction adapters

status: phase 2 verified; external smoke adapter verified; adapter docs updated

## goal
assess whether `pi-async-compaction` can expose reusable async lifecycle infrastructure so other Pi compaction packages can make their compaction work run in the background and apply safely later.

## constraints
- no runtime refactor until package audit identifies viable adapter boundaries
- avoid magic interop with arbitrary live-session mutation
- adapters must snapshot, run background work from snapshot, validate ready output, and apply through Pi-safe boundaries
- preserve current `pi-async-compaction` behavior as the first adapter
- package authors should opt in by importing/registering an adapter; we should not try to monkeypatch unrelated extensions

## pi contracts checked
- `session_before_compact` can return `{ compaction }` with `summary`, `firstKeptEntryId`, `tokensBefore`, optional `estimatedTokensAfter`, optional `details`.
- `ctx.compact()` triggers Pi's normal compaction flow and then `session_before_compact`.
- `ctx.requestCompactionBeforeNextTurn()` exists for current-turn coalescing, but it is not a general idle background handoff API.
- `pi.events` provides an inter-extension event bus, but a library import is cleaner than event-bus discovery because load order and type safety get sketchy.
- current `@earendil-works/pi-coding-agent` `CompactionResult` does not expose `preserveData`; snapcompact's richer contract appears tied to `@oh-my-pi/*` packages and is not directly portable without Pi upstream support.

## popularity/inventory snapshot
npm last-month download counts checked 2026-07-17:

| package | downloads/mo | architecture observed | async-adapter viability |
|---|---:|---|---|
| `@oh-my-pi/snapcompact@17.0.4` | 196328 | pure library, exports `compact(preparation, options)` returning summary/details/preserveData; no `pi` manifest in npm package | high conceptually, blocked by `preserveData` mismatch in current earendil Pi |
| `pi-mega-compact@0.7.7` | 7405 | hooks `session_before_compact`; deterministic/local Trident/RAPTOR pipeline; also live `context` trimming and resume nudges | medium; core lifecycle useful, but package owns complex live-view/state semantics |
| `pi-rtk-optimizer@0.9.0` | 7288 | `tool_result` output compaction, not session compaction | no; different problem |
| `pi-goosedump@0.10.6` | 5053 | goosedump-backed search/recall; mentions async session compaction | medium/unknown; needs deeper source audit if targeted |
| `pi-observational-memory@3.0.3` | 3490 | background memory/consolidation; `session_before_compact` renders prepared observations synchronously | high for lifecycle trigger/status only; summary is already precomputed-ish |
| `pi-ultra-compact@1.3.0` | 2700 | `session_before_compact` performs model summary inline; `/ultracompact` calls `ctx.compact()` | high; classic sync-hook summarizer that can split into adapter `prepare/run/validate` |
| `pi-smart-compact@7.22.0` | 2503 | typed staged pipeline with `PendingSlot`; `session_before_compact` consumes pending result or runs fresh under timeout | very high; already has adapter shape internally |
| `@monotykamary/pi-vcc@0.8.0` | 1825 | static algorithmic compiler in `session_before_compact`; proactive `ctx.compact()` triggers | medium; no LLM latency, async gives little speedup but core can handle safe handoff/proactive lifecycle |
| `pi-continue@0.9.3` | 1392 | continuation/handoff package; compaction is part of mid-run continuation protocol | no as generic adapter; too protocol-specific |
| `pi-compact-transcript@0.6.2` | 1045 | TUI render compaction, not session compaction | no |
| `pi-pact@0.4.0` | 818 | early partial compaction; custom cut + inline LLM summary in `session_before_compact`; triggers via `ctx.compact()` | high |
| `pi-safe-compact@0.1.1` | 338 | inline replacement for Pi summarizer with adaptive overflow retry | high; adapter can precompute same summary earlier |

## common adapter surface that survived audit

```ts
export type AsyncCompactionAdapter<TSnapshot, TResult> = {
  readonly id: string;
  readonly label: string;

  shouldStart(input: AdapterStartInput): boolean | StartDecision;
  prepare(input: AdapterPrepareInput): TSnapshot | undefined | Promise<TSnapshot | undefined>;
  run(input: AdapterRunInput<TSnapshot>): Promise<TResult>;
  validate(input: AdapterValidateInput<TSnapshot, TResult>): ValidationResult;
  toCompaction(input: AdapterApplyInput<TSnapshot, TResult>): CompactionResult;
};
```

minimal inputs needed:
- `branchEntries` snapshot
- Pi-compatible `CompactionPreparation` snapshot from our existing local mirror
- session id, leaf id, first-kept id, model key, thinking level, compaction settings
- auth/model/system-prompt access for model-backed adapters
- timeout/cancel signal

core owns:
- one-job lifecycle (`idle | pending | ready | stale | failed`)
- timeout/cancel/status ui
- safe idle-boundary triggering
- stale/replacement checks
- branch continuity validation
- same session/model/thinking/settings validation
- handoff through `session_before_compact`
- `session_compact` attribution/cleanup
- manual force command plumbing

each adapter owns:
- custom cut policy if it rejects Pi's `preparation.firstKeptEntryId`
- prompt/summary format
- LLM/model selection and auth needs
- custom details payload
- output validation beyond non-empty summary
- whether custom instructions are supported or must fall back

## viable integration models

### model a — library-first, recommended
package authors import our core and register their adapter:

```ts
import { registerAsyncCompaction } from "pi-async-compaction/core";

export default function (pi: ExtensionAPI) {
  registerAsyncCompaction(pi, myAdapter);
}
```

pros: type-safe, no load-order event bus weirdness, easiest tests.
cons: authors must change code and depend on our package.

### model b — adapter package wrappers
we publish thin wrappers like `pi-async-smart-compact` or bundled adapters.

pros: users can install an async variant without upstream author buy-in.
cons: dependency/license/maintenance hell; high chance of stale wrappers. use only for 1-2 strategic packages.

### model c — event-bus registration
other extensions emit `pi-async-compaction:register-adapter`.

pros: avoids direct import in theory.
cons: load-order and lifecycle edge cases. not worth it unless Pi formalizes extension capability discovery.

## specific package notes

### `pi-smart-compact`
- already stages a `PendingCompaction` and consumes it in `session_before_compact`.
- best pilot because its architecture is closest to ours.
- likely needs only an adapter facade around its existing staged pipeline.

### `pi-ultra-compact`
- clean hook: `handleBeforeCompact(engine)` snapshots messages, calls `engine.generateSummary`, returns `CompactionResult`.
- good pilot for extracting model-backed adapter ergonomics.
- watch circuit breaker state: adapter should report failure without globally tripping breaker on stale/aborted jobs.

### `pi-pact`
- custom cut policy (`buildPactPreparation`) is exactly why adapter needs `prepare()` not just Pi prep passthrough.
- could precompute after `turn_end` when threshold is crossed, then trigger/apply later.

### `pi-safe-compact`
- easiest summary-only adapter: takes Pi prep and runs adaptive overflow retry.
- async benefit: avoid paying overflow-retry latency at compaction time.

### `pi-observational-memory`
- summary render is synchronous from background memory state, so adapter core mostly helps with safe trigger/status, not latency.
- may not justify migration unless they want consistent lifecycle/status.

### `pi-mega-compact`
- complex: live `context` hook trimming, durable `session_before_compact`, resume nudges, persistent stores.
- can use core lifecycle ideas, but not a good first adapter.

### `@oh-my-pi/snapcompact`
- clean pure `compact(preparation, options)` function; perfect adapter API shape.
- blocker: current Pi package in this repo does not support `preserveData`, so frames would be lost unless Pi upstream adds support or adapter degrades to text-only (which defeats snapcompact).

## implementation phases

### phase 1 — internal core extraction, no public api yet
- [x] move current job/runtime-state/validation orchestration behind a `BuiltinPiAdapter`-shaped internal interface.
- [x] keep public behavior exactly identical.
- [x] tests: existing suite must pass unchanged; add adapter-contract tests around current behavior.

### phase 2 — public experimental adapter api
- [x] export `registerAsyncCompaction(pi, adapter, options?)` from a stable path.
- [x] document adapter lifecycle, snapshot invariants, and unsupported patterns.
- [x] add one test fixture adapter that returns deterministic summaries without LLM calls.

### phase 3 — first external pilot
- [x] prove package-level import/registration with a temp external adapter smoke package at `/tmp/pi-async-external-adapter-smoke`.
- [ ] choose either `pi-safe-compact` (simplest) or `pi-ultra-compact` (more representative).
- [ ] build a local compatibility adapter in test only or a branch in that package.
- [ ] prove ready-result reuse, stale rejection, custom details preservation, and fallback behavior.

### phase 4 — package author docs
- [x] write migration guide: “turn a `session_before_compact` hook into an async adapter”.
- [x] include a general adapter skeleton and migration checklist.
- [ ] include examples for:
  - Pi-prep passthrough adapter
  - custom-cut adapter (`pi-pact` style)
  - precomputed-memory adapter (`observational-memory` style)

### phase 5 — upstream asks
- public `prepareCompaction()`/token APIs for early snapshots; reduces our private mirror burden.
- typed `CompactionResult` support for richer preserved payloads if snapcompact-style archives should work.
- optional pre-prompt/pre-queued-message compaction handoff hook for safe apply before follow-ups.
- extension capability discovery/registration if event-bus adapter discovery is desired.

## anti-goals
- do not monkeypatch other packages' `session_before_compact` handlers.
- do not parse human-readable summaries to validate protocol state.
- do not add package-specific branches to core for every popular package.
- do not persist pending async jobs across reloads/restarts.
- do not claim universal async compatibility; packages that mutate live session state need refactors.

## next implementation step if approved
phase 1 only: extract current behavior into an internal adapter boundary while preserving all existing tests and public behavior.
