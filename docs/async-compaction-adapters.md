# async compaction adapters

`pi-async-compaction/core` lets another Pi compaction package reuse this package's background lifecycle while keeping its own summary logic.

use this when your package currently does expensive work inside `session_before_compact`, for example:

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const summary = await generateMySummary(event.preparation, ctx);
  return { compaction: { summary, firstKeptEntryId, tokensBefore, details } };
});
```

move the expensive part into an adapter instead:

```ts
import { registerAsyncCompaction } from "pi-async-compaction/core";
import type { AsyncCompactionAdapter, Snapshot } from "pi-async-compaction/core";
import type { CompactionResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Prepared = {
  readonly firstKeptEntryId: string;
  readonly snapshotLeafId: string;
  readonly sessionId: string;
  readonly modelKey: string;
  readonly settingsKey: string;
  readonly input: MyCompactionInput;
};

type SummaryResult = {
  readonly summary: string;
  readonly details: Record<string, unknown>;
};

const adapter: AsyncCompactionAdapter<Prepared, SummaryResult> = {
  id: "my-package",
  label: "my package compaction",

  prepare: ({ ctx, settings }) => {
    const branch = ctx.sessionManager.getBranch();
    const snapshotLeafId = branch[branch.length - 1]?.id;
    if (!snapshotLeafId || !ctx.model) return undefined;

    const input = buildMyCompactionInput(branch, settings);
    if (!input) return undefined;

    return {
      firstKeptEntryId: input.firstKeptEntryId,
      snapshotLeafId,
      sessionId: ctx.sessionManager.getSessionId(),
      modelKey: `${ctx.model.provider}/${ctx.model.id}`,
      settingsKey: JSON.stringify({
        enabled: settings.enabled,
        reserveTokens: settings.reserveTokens,
        keepRecentTokens: settings.keepRecentTokens,
      }),
      input,
    };
  },

  createSnapshot: ({ jobId, prepared }): Snapshot => ({
    jobId,
    sessionId: prepared.sessionId,
    snapshotLeafId: prepared.snapshotLeafId,
    firstKeptEntryId: prepared.firstKeptEntryId,
    modelKey: prepared.modelKey,
    thinkingLevel: "off",
    settingsKey: prepared.settingsKey,
    promptVersion: "my-package-summary-v1",
  }),

  run: async ({ prepared, signal }) => {
    return generateMySummary(prepared.input, signal);
  },

  toCompaction: ({ prepared, result }): CompactionResult => ({
    summary: result.summary,
    firstKeptEntryId: prepared.firstKeptEntryId,
    tokensBefore: prepared.input.tokensBefore,
    details: result.details,
  }),
};

export default function myExtension(pi: ExtensionAPI): void {
  registerAsyncCompaction(pi, adapter, {
    commandName: "my-async-compact-now",
    commandDescription: "Start my package async compaction now",
  });
}
```

## what your adapter owns

- selecting/snapshotting the messages to summarize
- custom cut policy, if you do not use Pi's default cut
- prompt format and model calls
- provider/auth handling needed by your summary engine
- package-specific validation of generated output
- `details` payload format
- fallback policy when your summary engine cannot run

## what `pi-async-compaction` owns

- starting work after `turn_end` once the async threshold is crossed
- one-job state: `idle`, `pending`, `ready`, `stale`, `failed`
- timeout and abort handling
- status line: `async_compaction ...` and `async_compaction ready`
- safe apply only when `ctx.isIdle()` and `!ctx.hasPendingMessages()`
- `session_before_compact` handoff
- stale checks for session/model/settings/branch drift
- preserving your `details` while adding `details.asyncPrefixCompaction`

## install while developing

from the adapter package repo, depend on a local checkout:

```bash
bun add ../pi_compaction
```

then import:

```ts
import { registerAsyncCompaction } from "pi-async-compaction/core";
```

for local Pi testing of this package itself:

```bash
cd /path/to/pi_compaction
pi install .
```

## when not to use this

- your package only compacts tool output (`tool_result`) rather than session history
- your package mutates live session state directly during `context` or rendering hooks
- your compaction result depends on hidden in-memory state that cannot be snapshotted
- your result needs `preserveData`; current `@earendil-works/pi-coding-agent` `CompactionResult` does not expose it

## migration checklist

1. identify the expensive code inside `session_before_compact`
2. move input collection into `prepare()`
3. make `prepare()` return a stable snapshot, not live mutable session references
4. move model work into `run()` and honor `signal`
5. return Pi's normal `CompactionResult` shape from `toCompaction()`
6. remove or gate the old `session_before_compact` handler so it does not race the adapter
7. add tests for:
   - ready result handoff
   - stale branch rejection
   - custom details preservation
   - no handoff when the adapter returns no prepared input

## current api status

experimental. the import path is stable enough for pilot integrations:

```ts
import { registerAsyncCompaction } from "pi-async-compaction/core";
```

but the adapter shape may still change after real package pilots.
