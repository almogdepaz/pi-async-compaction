import { describe, expect, test } from "bun:test";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { startAsyncJobWithDeps } from "../src/job";
import { createRuntimeState } from "../src/runtime-state";
import { settingsKey } from "../src/utils";
import { assistantEntry, asyncJobContext, asyncJobDeps, compactableEntries, readyJob, settings, userEntry } from "./test-fixtures";

describe("startAsyncJob lifecycle", () => {
	test("replaces an unchanged-leaf ready job when settings drift", () => {
		const state = createRuntimeState();
		state.status = "ready";
		state.jobId = "async-prefix-compaction-1";
		state.jobCounter = 1;
		state.ready = readyJob({ snapshotLeafId: "u2" });
		const changedSettings = { ...settings, reserveTokens: 101 };
		const never = new Promise<CompactionResult>(() => {});

		const outcome = startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({
				getCompactionSettings: () => changedSettings,
				buildAsyncCompactionResult: () => never,
			}),
		);

		expect(outcome).toBe("started");
		expect(String(state.status)).toBe("pending");
		expect(state.jobId).toBe("async-prefix-compaction-2");
	});

	test("replaces a ready job when the current branch no longer contains its snapshot boundary", () => {
		const state = createRuntimeState();
		state.status = "ready";
		state.jobId = "async-prefix-compaction-1";
		state.jobCounter = 1;
		state.ready = readyJob();
		const unrelatedBranch = [
			userEntry("x1", null, "unrelated old prefix"),
			assistantEntry("x2", "x1", "unrelated assistant"),
			userEntry("x3", "x2", "unrelated tail"),
		];
		const never = new Promise<CompactionResult>(() => {});

		const outcome = startAsyncJobWithDeps(
			asyncJobContext(unrelatedBranch),
			state,
			asyncJobDeps({ buildAsyncCompactionResult: () => never }),
		);

		expect(outcome).toBe("started");
		expect(String(state.status)).toBe("pending");
		expect(state.jobId).toBe("async-prefix-compaction-2");
		expect(state.ready).toBeUndefined();
	});

	test("replaces a ready job when appended tail makes it too large", () => {
		const state = createRuntimeState();
		state.status = "ready";
		state.jobId = "async-prefix-compaction-1";
		state.jobCounter = 1;
		state.ready = {
			jobId: "async-prefix-compaction-1",
			sessionId: "session-1",
			snapshotLeafId: "a1",
			firstKeptEntryId: "u2",
			modelKey: "openai/test-model",
			thinkingLevel: "off",
			settingsKey: settingsKey(settings),
			promptVersion: "pi-compact-background-v1",
			result: {
				summary: "x".repeat(4_000),
				firstKeptEntryId: "u2",
				tokensBefore: 100,
				details: {
					readFiles: [],
					modifiedFiles: [],
					asyncPrefixCompaction: {
						jobId: "async-prefix-compaction-1",
						snapshotLeafId: "a1",
						modelKey: "openai/test-model",
						thinkingLevel: "off",
						settingsKey: settingsKey(settings),
						promptVersion: "pi-compact-background-v1",
					},
				},
			},
		};
		const entries = [...compactableEntries(), assistantEntry("a2", "u2", "new tail")];
		const never = new Promise<never>(() => {});

		startAsyncJobWithDeps(
			asyncJobContext(entries),
			state,
			asyncJobDeps({ buildAsyncCompactionResult: () => never }),
		);

		expect(String(state.status)).toBe("pending");
		expect(state.jobId).toBe("async-prefix-compaction-2");
		expect(state.ready).toBeUndefined();
	});
});
