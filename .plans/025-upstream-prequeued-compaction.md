# upstream pre-queued compaction pr

status: upstream issue opened; local implementation drafted in `/Users/home/Dev/pi-upstream` on branch `deferred-extension-compaction`; pr not submitted.

upstream issue: https://github.com/earendil-works/pi/issues/6553

## research findings
- upstream repo cloned/read at `/Users/home/Dev/pi-upstream` on main `8479bd8`.
- the needed low-level checkpoint already exists: `packages/agent/src/agent-loop.ts` calls `prepareNextTurn` after `turn_end` and before draining steering/follow-up queues.
- `packages/coding-agent/src/core/agent-session.ts` currently uses that checkpoint only to refresh system prompt/tools/model, not to apply extension-requested compaction.
- existing `ctx.compact()` aborts the active run, so it is intentionally wrong for pre-queued in-run compaction.
- contribution gate is strict: new PRs auto-close unless the contributor already has `lgtm`; issue/discord first is the sane route.

## assumptions
1. goal is to let `pi-async-compaction` apply a ready compaction before pi drains queued steering/follow-up messages into the next provider request.
2. upstream pi maintainers will prefer a generic lifecycle/API change over plugin-specific async-compaction logic.
3. the PR should preserve current queue semantics: queued messages are not dropped/reordered, only delivered after any requested/required compaction has updated the active context.
4. the plugin should keep falling back safely if the new upstream API is absent.

## 1. confirm upstream shape
- inspect pi-mono source/tests locally or clone/fork it.
- verify current low-level order: `turn_end` → `prepareNextTurn` → drain steering queue → next provider request; follow-ups drain at loop idle.
- identify exact test files for agent queueing and coding-agent compaction.

## 2. propose minimal core contract
preferred shape:
- add a safe way to request compaction at the post-turn/pre-queue boundary.
- likely API: extend `ctx.compact()` with an explicit deferred option, e.g. `{ delivery: "beforeNextTurn" }`, or add a narrowly named method like `ctx.requestCompactionBeforeNextTurn()`.
- implementation consumes the request inside `AgentSession`'s existing `prepareNextTurnWithContext` hook, runs compaction without aborting the active run, then returns a refreshed context snapshot before queues are drained.

non-goal:
- do not make agent-core know about pi compaction internals.
- do not reorder queued messages.
- do not introduce plugin-specific hooks.

## implementation status
- branch: `/Users/home/Dev/pi-upstream` `deferred-extension-compaction`
- implemented `ctx.requestCompactionBeforeNextTurn()`.
- request is stored on `AgentSession` only before the current low-level `agent_end`; it is cleared at each `agent_end`, including before retries/continuations.
- request is consumed from existing `prepareNextTurnWithContext` before steering/follow-up queues are drained.
- compaction uses the in-place path with `reason: "deferred"`; the active run abort signal cancels it; existing `ctx.compact()` behavior is unchanged.
- extension-provided compaction is consulted before model auth, so a ready extension result does not require a second credential lookup.
- regressions cover direct steering/follow-up ordering, cancellation, failed compaction queue delivery, generated-compaction aborts, no-auth extension results, repeated-request coalescing, and stale requests across retries. Shared deferred-compaction setup keeps these lifecycle tests focused.
- validation:
  - `npm run check` passes.
  - touched coding-agent tests pass: `test/suite/agent-session-queue.test.ts`, `test/suite/agent-session-compaction.test.ts`, `test/agent-session-auto-compaction-queue.test.ts`, `test/suite/regressions/5217-compaction-reason.test.ts`, `test/extensions-runner.test.ts`, `test/trigger-compact-extension.test.ts`, `test/interactive-mode-compaction.test.ts`.
  - full `./test.sh` currently fails on 3 baseline failures also reproduced on clean `main`: two Node type-stripping stderr assertions and one bash-output truncation regression. One unrelated footer watcher timeout also occurred once and passed immediately when rerun alone.

## 3. upstream implementation sketch
- in `packages/coding-agent/src/core/extensions/types.ts`: type the new compact option/method.
- in `packages/coding-agent/src/core/agent-session.ts`:
  - store a pending deferred-compaction request from extension context.
  - during `prepareNextTurnWithContext`, if requested, run an in-place compaction path that does not abort the current run.
  - rebuild session context and return it via `AgentLoopTurnUpdate.context`.
  - clear the request on success/failure/abort.
- possibly refactor existing manual/auto compaction code to share append+refresh+event emission without duplicating logic.

## 4. tests upstream
- regression: steering message queued during tool execution is delivered after compaction summary is inserted, not before.
- regression: follow-up message after a terminal assistant response is delivered after compaction when requested.
- safety: failed/cancelled extension compaction does not drop queued messages.
- compatibility: normal `ctx.compact()` behavior remains unchanged unless the new option/method is used.

## 5. plugin follow-up after upstream lands
- update `pi-async-compaction` to call the new deferred/pre-next-turn compaction API when a ready result exists during/after `turn_end` and queued messages are pending.
- keep current idle/no-pending `ctx.compact()` path for older pi versions.
- bump peer dependency to the first pi version containing the upstream API, or feature-detect and keep a wider range if feasible.
- add parity/regression tests in this repo for queued-message handoff.

## upstream submission strategy

### contribution gate facts
- `.github/workflows/pr-gate.yml` closes PRs from contributors not listed with `pr` capability in `.github/APPROVED_CONTRIBUTORS`.
- `CONTRIBUTING.md` says: open an issue first; only submit PR after maintainer replies `lgtm`.
- issue template says: keep it short, one screen, own voice.
- do not edit changelogs.
- before PR: `npm run check` and `./test.sh`.

### style from accepted PRs
good examples inspected:
- #6350 `feat(coding-agent): add before_provider_headers extension hook` — concise what/why/how, concrete extension use case, tests/docs, ~136 additions.
- #6470 `feat(coding-agent): expand ~ in shellPath setting` — tiny scope, links issue, exact validation, notes unrelated pre-existing failures.
- #6417 `feat(agent): support custom metadata in jsonl session headers` — summary, why, validation, narrow storage semantics.

avoid:
- long agent reports, huge conflict dumps, or internal review summaries in the issue body.
- vague “context quality” arguments. maintainer pushed back on this before.
- mentioning Matt Pocock/lost-in-middle/etc. reads like filler and was explicitly unhelpful in #5939.
- opening PR before `lgtm`; it will auto-close.

### issue draft (human, short)
title: `Extension compaction request before queued messages are drained`

What do you want to change?

> Add a small extension API for requesting compaction at Pi's existing post-turn checkpoint, before queued steering/follow-up messages are drained into the next provider request.
>
> Shape is flexible. The smallest version I can see is either `ctx.compact({ delivery: "beforeNextTurn" })` or `ctx.requestCompactionBeforeNextTurn()`.

Why?

> I maintain an extension that prepares compaction in the background. Today it can safely apply the result only when Pi is idle and there are no queued messages.
>
> If the user queues a steering/follow-up message while the agent is still running, Pi drains that queue before the extension can apply the ready compaction. The queued message is preserved, but it is sent with the old bloated context instead of the compacted context.
>
> Calling current `ctx.compact()` is not a safe workaround because it aborts the active run.

How? (optional)

> Pi already has the right checkpoint: `turn_end -> prepareNextTurn -> drain queue`. I would like to wire a coding-agent extension request into that checkpoint, run compaction without aborting the active run, rebuild the session context, and then let the existing queue drain normally.
>
> I can send a small PR with tests for steering/follow-up order if this boundary/API is acceptable.

### pr body shape after lgtm
title: `feat(coding-agent): allow deferred extension compaction before next turn`

```
## What

Adds an extension API to request compaction at the existing post-turn checkpoint before queued messages are delivered.

## Why

Extensions can prepare compaction results in the background, but current `ctx.compact()` aborts active work. If a steering/follow-up message is queued during an active run, Pi currently drains that queue before an extension can apply a ready compaction.

This lets extensions request the safe in-run boundary instead: compact first, then deliver the queued messages in the existing order.

## How

- [exact API chosen after maintainer feedback]
- store one pending deferred compaction request on `AgentSession`
- consume it from the existing `prepareNextTurnWithContext` wrapper
- rebuild and return the compacted context before queue drain
- leave existing `ctx.compact()` behavior unchanged

## Testing

- `npm run check`
- `./test.sh`
- focused tests: [list exact vitest commands]
```

### implementation guardrails
- one API only; no broad lifecycle rewrite.
- no changelog edits.
- no plugin names in public API or code.
- failed/cancelled deferred compaction must clear the pending request and let queued messages continue; never drop/reorder queue contents.
- prefer tests proving message ordering/context visibility over private-method tests.
