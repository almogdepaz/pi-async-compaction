# pi_compaction context index

## How to use

- read this file first
- choose module docs by changed path/task
- for cross-boundary work, read only the related modules named by routing/coupling guidance
- contextless.entries are machine coverage only and must not appear in the human index read path
- reports are not part of the ordinary index read path

## Route by path/task

| touching / task | read first | also inspect | why |
| --- | --- | --- | --- |
| `src/**` | `edc-context/modules/pi-compaction.md` | pinned Pi source/types when behavior must match Pi internals | async compaction extension runtime, job lifecycle, validation, state, provider/auth bridge, hook integration, and public adapter/core APIs live behind one module boundary |
| `docs/**`, `README.md`, `ASYNC_COMPACTION_DESIGN.md`, `llms.txt` | `edc-context/modules/pi-compaction.md` | source/tests for any documented behavior being changed | public contract, architecture, and user-facing behavior must stay aligned with implementation and parity expectations |
| `test/**`, `test-fixtures/**` | `edc-context/modules/pi-compaction.md` | relevant Pi fixture/source expectations | tests encode state-machine, parity, validation, adapter, failure/timeout, release, and Pi-integration guarantees |
| `scripts/**`, `package.json`, `.github/**`, release/package metadata | `edc-context/modules/pi-compaction.md` | release docs/changelog when publishing behavior changes | release checks, package exports, Pi package registration, CI, and dependency/API drift can break install/runtime compatibility |
| async compaction safety, auto-apply/auto-resume, markers, adapters, preparation parity, or provider auth forwarding | `edc-context/modules/pi-compaction.md` | Pi compaction implementation and parity tests | these are the highest-blast-radius contracts in the package |

This is a single-module repository: all source, tests, docs, and package metadata route to the same architectural context document.

## Critical global invariants

- Pi is the durable persistence and final compaction authority; this package owns only in-memory precompute state and hands ready summaries to Pi through extension hooks.
- A ready job is usable only for the same session, model key, thinking level, compaction settings, first-kept boundary, and branch ancestry captured at snapshot time.
- Appended tail is safe only when the current branch still contains the first-kept entry and snapshot leaf in order, and preview sizing proves the post-compaction reserve budget remains valid.
- Correlation must match `adapterId`, `jobId`, and `promptVersion`; ignore foreign-extension, non-extension, or stale-marker compactions.
- Custom `/compact <instructions>` falls back to Pi synchronous compaction, not an async-precomputed summary.
- Provider/auth forwarding intentionally preserves Pi-compatible API key, nullable headers, environment, retry, base URL, and request-header semantics.

## Cross-module coupling / blast radius

- Pi extension hooks define the main flow: `turn_end` may precompute, `session_before_compact` hands off a ready result, and `session_compact` / `session_compact_failed` close correlation.
- Manual `/async-compact-now` enters the same lifecycle as automatic precompute while bypassing only the early-start window.
- Safe auto-apply is bounded by validation, optional active-turn abort, Pi `compact()`, marker-correlated persistence confirmation, and deferred `continue` only if no user/queued message intervened.
- Adapter authors own adapter-specific semantic correctness; core bounds them with lifecycle safety, generic validation, non-empty summary checks, marker metadata, status, and cancellation.
- Provider/auth failures, compaction failures, timeout aborts, apply errors, and observer exceptions are contained to correlated job state or diagnostics rather than global session state.
