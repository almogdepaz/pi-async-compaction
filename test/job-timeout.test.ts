import { describe, expect, test } from "bun:test";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { InvalidationReason } from "../src/constants";
import { startAsyncJobWithDeps } from "../src/job";
import { createRuntimeState } from "../src/runtime-state";
import { asyncJobContext, asyncJobDeps, compactableEntries } from "./test-fixtures";

function asyncJobDepsWithCapturedTimeout(overrides: Partial<Parameters<typeof startAsyncJobWithDeps>[2]> = {}): {
	readonly deps: Parameters<typeof startAsyncJobWithDeps>[2];
	readonly triggerTimeout: () => void;
} {
	let timeoutHandler: (() => void) | undefined;
	return {
		deps: asyncJobDeps({
			getTimeoutMs: () => 1,
			setTimeout: (handler) => {
				timeoutHandler = handler;
				return 0 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout: () => undefined,
			...overrides,
		}),
		triggerTimeout: () => {
			if (!timeoutHandler) throw new Error("timeout was not scheduled");
			timeoutHandler();
		},
	};
}


describe("startAsyncJob lifecycle", () => {
	test("marks timeout aborts stale with a timeout reason", async () => {
		const state = createRuntimeState();
		const { deps, triggerTimeout } = asyncJobDepsWithCapturedTimeout({
			buildAsyncCompactionResult: (_preparation, _model, _ctx, _thinkingLevel, signal) =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});

		startAsyncJobWithDeps(asyncJobContext(compactableEntries()), state, deps);
		triggerTimeout();
		await Promise.resolve();

		expect(state.status).toBe("stale");
		expect(state.reason).toBe(InvalidationReason.TIMEOUT);
	});

	test("manual force uses the configured timeout", async () => {
		const state = createRuntimeState();
		const { deps, triggerTimeout } = asyncJobDepsWithCapturedTimeout({
			buildAsyncCompactionResult: (_preparation, _model, _ctx, _thinkingLevel, signal) =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});

		startAsyncJobWithDeps(asyncJobContext(compactableEntries()), state, deps, { force: true });
		triggerTimeout();
		await Promise.resolve();

		expect(state.status).toBe("stale");
		expect(state.reason).toBe(InvalidationReason.TIMEOUT);
	});

	test("timeout clears pending state even when background compaction never settles", () => {
		const state = createRuntimeState();
		const statusValues: Array<string | undefined> = [];
		const never = new Promise<CompactionResult>(() => {});
		const { deps, triggerTimeout } = asyncJobDepsWithCapturedTimeout({
			setCliStatus: (_ctx, text) => statusValues.push(text),
			buildAsyncCompactionResult: () => never,
		});

		startAsyncJobWithDeps(asyncJobContext(compactableEntries()), state, deps);
		triggerTimeout();

		expect(state.status).toBe("stale");
		expect(state.reason).toBe(InvalidationReason.TIMEOUT);
		expect(statusValues).toEqual(["async_compaction ...", undefined]);
	});
});
