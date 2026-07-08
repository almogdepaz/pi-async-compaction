import { describe, expect, test } from "bun:test";
import { InvalidationReason } from "../src/constants";
import { startAsyncJobWithDeps } from "../src/job";
import { createRuntimeState } from "../src/runtime-state";
import { asyncJobContext, asyncJobDeps, compactableEntries } from "./test-fixtures";

describe("startAsyncJob lifecycle", () => {
	test("records apply failures reported by Pi compaction", async () => {
		const state = createRuntimeState();

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({ triggerCompaction: (_ctx, onError) => onError(new Error("already compacted")) }),
		);
		await Promise.resolve();

		expect(state.status).toBe("failed");
		expect(state.reason).toBe(InvalidationReason.FAILED);
		expect(state.error).toBe("apply failed: already compacted");
	});

	test("records apply failures after a ready job has been handed off", async () => {
		const state = createRuntimeState();
		let onApplyError: ((error: Error) => void) | undefined;

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({ triggerCompaction: (_ctx, onError) => (onApplyError = onError) }),
		);
		await Promise.resolve();

		expect(state.status).toBe("ready");
		expect(state.jobId).toBe("async-prefix-compaction-1");
		state.status = "idle";
		state.ready = undefined;
		state.reason = undefined;
		state.lastHandedOffJobId = "async-prefix-compaction-1";

		onApplyError?.(new Error("render failed"));

		expect(String(state.status)).toBe("failed");
		expect(String(state.reason)).toBe(InvalidationReason.FAILED);
		expect(state.error).toBe("apply failed: render failed");
	});

	test("records background compaction failures", async () => {
		const state = createRuntimeState();

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({ buildAsyncCompactionResult: async () => Promise.reject(new Error("auth failed")) }),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(state.status).toBe("failed");
		expect(state.reason).toBe(InvalidationReason.FAILED);
		expect(state.error).toBe("auth failed");
	});

	test("records empty background compaction summaries as actionable failures", async () => {
		const state = createRuntimeState();

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({
				buildAsyncCompactionResult: async (preparation) => ({
					summary: "  \n\t  ",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
				}),
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(state.status).toBe("failed");
		expect(state.reason).toBe(InvalidationReason.FAILED);
		expect(state.error).toBe("empty compaction summary");
	});
});
