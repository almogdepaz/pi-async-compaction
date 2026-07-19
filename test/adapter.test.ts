import { describe, expect, test } from "bun:test";
import type { AsyncCompactionAdapter } from "../src/adapter";
import { startAsyncJobWithDeps } from "../src/job";
import { createRuntimeState } from "../src/runtime-state";
import type { LocalCompactionPreparation } from "../src/types";
import { asyncJobContext, asyncJobDeps, compactableEntries, settings } from "./test-fixtures";

describe("internal async compaction adapter seam", () => {
	test("startAsyncJob delegates prepare, run, and result conversion to the configured adapter", async () => {
		const state = createRuntimeState();
		const calls: string[] = [];
		const preparation: LocalCompactionPreparation = {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 123,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings,
		};
		const adapter: AsyncCompactionAdapter<
			{ readonly preparation: LocalCompactionPreparation },
			{ readonly summary: string; readonly firstKeptEntryId: string; readonly tokensBefore: number }
		> = {
			id: "test-adapter",
			label: "test adapter",
			prepare: () => {
				calls.push("prepare");
				return { preparation };
			},
			createSnapshot: ({ jobId }: { readonly jobId: string }) => {
				calls.push("createSnapshot");
				return {
					jobId,
					sessionId: "session-1",
					snapshotLeafId: "u2",
					firstKeptEntryId: "u2",
					modelKey: "openai/test-model",
					thinkingLevel: "off" as const,
					settingsKey: JSON.stringify(settings),
					promptVersion: "test-prompt-v1",
				};
			},
			run: async () => {
				calls.push("run");
				return { summary: "adapter summary", firstKeptEntryId: "u2", tokensBefore: 123 };
			},
			toCompaction: ({ result }) => {
				calls.push("toCompaction");
				return result;
			},
		};

		const outcome = startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({
				adapter,
				buildAsyncCompactionResult: async () => {
					throw new Error("direct compaction path should not run");
				},
			}),
		);
		await Promise.resolve();

		expect(outcome).toBe("started");
		expect(calls).toEqual(["prepare", "createSnapshot", "run", "toCompaction"]);
		expect(state.status).toBe("ready");
		expect(state.ready?.result.summary).toBe("adapter summary");
		expect(state.ready?.result.details?.asyncPrefixCompaction.jobId).toBe("async-prefix-compaction-1");
	});
});
