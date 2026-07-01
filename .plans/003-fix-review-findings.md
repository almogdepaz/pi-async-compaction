# fix review findings one by one

status: in progress

## finding 1 — async-after-async file-op inheritance
- severity: high
- status: fixed
- regression test: `src/index.test.ts`
- red: `bun test src/index.test.ts` failed because `prior-read.ts` was not inherited
- fix: inherit previous compaction file details when `fromHook` compaction has this extension's `asyncPrefixCompaction.promptVersion` marker
- green: `bun test` passes

## finding 2 — local preparation mirrors Pi internals and can drift
- severity: medium
- status: mitigated self-contained
- fix: added drift sentinel tests for mirrored preparation behavior: own async compaction inheritance, Pi compaction inheritance, foreign hook rejection, and split-turn prep semantics
- check scripts: `bun run test`, `bun run check`, `bun run typecheck`
- green: all scripts pass

## finding 3 — no broader test harness for core invariants
- severity: medium
- status: partially fixed
- fix: added validation tests for successful append-tail apply, custom instruction fallback, missing snapshot leaf fallback, and too-large preview fallback
- green: `bun run test`, `bun run check`, `bun run typecheck`, and Pi load smoke pass

## finding 4 — module-level mutable async state is race-sensitive
- severity: medium
- status: mitigated
- fix: moved mutable runtime state into a `RuntimeState` object created inside the extension factory; event handlers now close over per-extension state instead of sharing module-level state
- green: `bun run test`, `bun run check`, `bun run typecheck`, and Pi load smoke pass

## finding 5 — single source file exceeds 500 LOC
- severity: medium
- status: fixed
- fix: split production code into focused modules: `constants.ts`, `types.ts`, `utils.ts`, `preparation.ts`, `validation.ts`, `runtime-state.ts`, `job.ts`, and slim `index.ts`
- result: `src/index.ts` is 83 LOC; largest production file is `src/job.ts` at 163 LOC
- green: `bun run test`, `bun run check`, `bun run typecheck`, and Pi load smoke pass

## finding 6 — hardcoded local paths in docs
- severity: low
- status: fixed
- fix: docs now use `pi install .` and `pi -e .`

## finding 7 — `Model<any>` type escape
- severity: low
- status: fixed where owned
- fix: changed local function/test signatures from `Model<any>` to `Model<Api>`
- note: Pi public extension APIs may still expose `Model<any>` upstream

## remaining findings
- none
