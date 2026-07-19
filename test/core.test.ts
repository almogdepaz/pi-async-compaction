import { describe, expect, test } from "bun:test";
import type { CompactionResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAsyncCompaction } from "../src/core";
import type { AsyncCompactionAdapter } from "../src/adapter";
import { startAsyncJobWithDeps } from "../src/job";
import type { Snapshot } from "../src/types";
import { asyncJobContext, asyncJobDeps, compactableEntries, settings, validationEvent } from "./test-fixtures";

describe("registerAsyncCompaction", () => {
	test("registers lifecycle hooks that run a supplied adapter and hand off its compaction", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(eventName, handler);
			},
			registerCommand: () => undefined,
		} as unknown as ExtensionAPI;
		const snapshot: Snapshot = {
			jobId: "async-prefix-compaction-1",
			sessionId: "session-1",
			snapshotLeafId: "u2",
			firstKeptEntryId: "u2",
			modelKey: "openai/test-model",
			thinkingLevel: "off",
			settingsKey: JSON.stringify(settings),
			promptVersion: "adapter-test-v1",
		};
		const adapter: AsyncCompactionAdapter<{ readonly input: string }, { readonly text: string }> = {
			id: "package-adapter",
			label: "package adapter",
			prepare: () => ({ input: "snapshot" }),
			createSnapshot: ({ jobId }) => ({ ...snapshot, jobId }),
			run: async ({ prepared }) => ({ text: `${prepared.input} summary` }),
			toCompaction: ({ result }): CompactionResult => ({
				summary: result.text,
				firstKeptEntryId: "u2",
				tokensBefore: 123,
				details: { packageAdapter: true },
			}),
		};

		registerAsyncCompaction(pi, adapter, { commandName: false }, {
			startAsyncJob: (ctx, state, options) => startAsyncJobWithDeps(ctx, state, asyncJobDeps(), options),
		});
		const turnEnd = handlers.get("turn_end");
		const beforeCompact = handlers.get("session_before_compact");
		if (!turnEnd || !beforeCompact) throw new Error("expected lifecycle handlers");

		turnEnd({}, { ...asyncJobContext(compactableEntries()), isIdle: () => false } as ExtensionContext);
		await Promise.resolve();
		await Promise.resolve();

		const handoff = await beforeCompact(validationEvent(), asyncJobContext(compactableEntries()));

		expect(handoff).toEqual({
			compaction: expect.objectContaining({
				summary: "snapshot summary",
				firstKeptEntryId: "u2",
				tokensBefore: 123,
				details: expect.objectContaining({
					packageAdapter: true,
					asyncPrefixCompaction: expect.objectContaining({ jobId: "async-prefix-compaction-1" }),
				}),
			}),
		});
	});
});
