import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTER_ID, EXTENSION_NAME } from "../src/constants";
import { applyReadyCompaction, buildAsyncCompactionResult, startAsyncJobWithDeps } from "../src/job";
import { createRuntimeState } from "../src/runtime-state";
import { asyncJobContext, asyncJobDeps, compactableEntries, readyJob, settings } from "./test-fixtures";

const builtinJobId = `${EXTENSION_NAME}:${BUILTIN_ADAPTER_ID}:1`;

describe("startAsyncJob lifecycle", () => {
	test("does not start when disabled", () => {
		const state = createRuntimeState();

		startAsyncJobWithDeps(asyncJobContext(compactableEntries()), state, asyncJobDeps({ isEnabled: () => false }));

		expect(state.status).toBe("idle");
		expect(state.jobId).toBeUndefined();
	});

	test("passes resolved auth environment to Pi compaction", async () => {
		const entries = compactableEntries();
		const ctx = {
			...asyncJobContext(entries),
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({
					ok: true as const,
					apiKey: "test-key",
					env: { AWS_PROFILE: "compaction-profile" },
				}),
			},
		} as unknown as ReturnType<typeof asyncJobContext>;
		if (!ctx.model) throw new Error("expected test model");
		let compactArguments: unknown[] | undefined;
		await buildAsyncCompactionResult(
			{
				firstKeptEntryId: "u2",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings,
			},
			ctx.model,
			ctx,
			"off",
			new AbortController().signal,
			async (...args) => {
				compactArguments = args;
				return { summary: "async summary", firstKeptEntryId: "u2", tokensBefore: 100 };
			},
		);

		expect(compactArguments?.[8]).toEqual({ AWS_PROFILE: "compaction-profile" });
	});

	test("omits nullable provider headers at the Pi compaction boundary", async () => {
		const ctx = {
			...asyncJobContext(compactableEntries()),
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({
					ok: true as const,
					apiKey: "test-key",
					headers: { "x-present": "value", "x-removed": null },
				}),
			},
		} as unknown as ReturnType<typeof asyncJobContext>;
		if (!ctx.model) throw new Error("expected test model");
		let compactArguments: unknown[] | undefined;

		await buildAsyncCompactionResult(
			{
				firstKeptEntryId: "u2",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings,
			},
			ctx.model,
			ctx,
			"off",
			new AbortController().signal,
			async (...args) => {
				compactArguments = args;
				return { summary: "async summary", firstKeptEntryId: "u2", tokensBefore: 100 };
			},
		);

		expect(compactArguments?.[3]).toEqual({ "x-present": "value" });
	});

	test("sets cli status line while a background job is pending", () => {
		const state = createRuntimeState();
		const never = new Promise<never>(() => {});
		const statusValues: Array<string | undefined> = [];

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({
				buildAsyncCompactionResult: () => never,
				setCliStatus: (_ctx, _statusKey, text) => statusValues.push(text),
			}),
		);

		expect(state.status).toBe("pending");
		expect(state.jobId).toBe(builtinJobId);
		expect(statusValues).toEqual(["built-in Pi compaction: preparing"]);
	});

	test("namespaces pending job ids and status by adapter identity and label", () => {
		const state = createRuntimeState("partner.adapter", "partner compaction");
		const never = new Promise<never>(() => {});
		const statusValues: Array<{ readonly key: string; readonly text: string | undefined }> = [];

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({
				buildAsyncCompactionResult: () => never,
				setCliStatus: ((_: unknown, key: string, text: string | undefined) => statusValues.push({ key, text })) as Parameters<typeof startAsyncJobWithDeps>[2]["setCliStatus"],
			}),
		);

		expect(state.jobId).toBe("async-prefix-compaction:partner.adapter:1");
		expect(statusValues).toEqual([{ key: "async-prefix-compaction:partner.adapter", text: "partner compaction: preparing" }]);
	});

	test("starts a pending job below the async threshold when forced", () => {
		const state = createRuntimeState();
		const never = new Promise<never>(() => {});

		const outcome = startAsyncJobWithDeps(
			asyncJobContext(compactableEntries(), 100),
			state,
			asyncJobDeps({ buildAsyncCompactionResult: () => never }),
			{ force: true },
		);

		expect(outcome).toBe("started");
		expect(state.status).toBe("pending");
		expect(state.jobId).toBe(builtinJobId);
	});

	test("does not auto-start when reserve leaves no start window", () => {
		const state = createRuntimeState();
		let buildCalls = 0;

		const outcome = startAsyncJobWithDeps(
			asyncJobContext(compactableEntries(), 30_000, 32_000),
			state,
			asyncJobDeps({
				buildAsyncCompactionResult: async (preparation) => {
					buildCalls++;
					return {
						summary: "async summary",
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: { readFiles: [], modifiedFiles: [] },
					};
				},
				getCompactionSettings: () => ({ ...settings, reserveTokens: 16_384 }),
			}),
		);

		expect(outcome).toBe("start_window_empty");
		expect(state.status).toBe("idle");
		expect(buildCalls).toBe(0);
	});

	test("clears cli status line when a background job becomes ready", async () => {
		const state = createRuntimeState();
		const statusValues: Array<string | undefined> = [];

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({ setCliStatus: (_ctx, _statusKey, text) => statusValues.push(text) }),
		);
		await Promise.resolve();

		expect(state.status).toBe("ready");
		expect(state.ready?.result.summary).toBe("async summary");
		expect(state.ready?.result.details?.asyncPrefixCompaction.jobId).toBe(builtinJobId);
		expect(statusValues).toEqual(["built-in Pi compaction: preparing", undefined]);
	});

	test("triggers Pi compaction when a background job becomes ready while idle", async () => {
		const state = createRuntimeState();
		let compactTriggered = 0;

		startAsyncJobWithDeps(
			{
				...asyncJobContext(compactableEntries()),
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
			state,
			asyncJobDeps({ triggerCompaction: () => compactTriggered++ }),
		);
		await Promise.resolve();

		expect(compactTriggered).toBe(1);
	});

	test("does not trigger Pi compaction when a background job becomes ready during an active turn without an abortable signal", async () => {
		const state = createRuntimeState();
		let compactTriggered = 0;

		startAsyncJobWithDeps(
			{
				...asyncJobContext(compactableEntries()),
				isIdle: () => false,
				hasPendingMessages: () => false,
			},
			state,
			asyncJobDeps({ triggerCompaction: () => compactTriggered++ }),
		);
		await Promise.resolve();

		expect(state.status).toBe("ready");
		expect(compactTriggered).toBe(0);
	});

	test("force-stops the active agent before applying a ready job over the async threshold", () => {
		const state = createRuntimeState();
		state.status = "ready";
		state.jobId = builtinJobId;
		state.jobCounter = 1;
		state.ready = {
			...readyJob({ snapshotLeafId: "u2" }),
			jobId: builtinJobId,
			snapshotLeafId: "u2",
		};
		let abortCalls = 0;
		let compactTriggered = 0;
		const signal = new AbortController().signal;

		const applied = applyReadyCompaction(
			{
				...asyncJobContext(compactableEntries()),
				isIdle: () => false,
				hasPendingMessages: () => false,
				signal,
				abort: () => abortCalls++,
			},
			state,
			asyncJobDeps({ triggerCompaction: () => compactTriggered++ }),
		);

		expect(applied).toBe(true);
		expect(abortCalls).toBe(1);
		expect(compactTriggered).toBe(1);
	});

	test("claims a ready job before triggering Pi compaction", () => {
		const state = createRuntimeState();
		state.status = "ready";
		state.jobId = builtinJobId;
		state.jobCounter = 1;
		state.ready = {
			...readyJob({ snapshotLeafId: "u2" }),
			jobId: builtinJobId,
			snapshotLeafId: "u2",
		};
		let compactTriggered = 0;
		const deps = asyncJobDeps({ triggerCompaction: () => compactTriggered++ });

		expect(applyReadyCompaction(asyncJobContext(compactableEntries()), state, deps)).toBe(true);
		expect(applyReadyCompaction(asyncJobContext(compactableEntries()), state, deps)).toBe(false);
		expect(compactTriggered).toBe(1);
	});

	test("does not force-stop an abortable active agent below the async threshold", () => {
		const state = createRuntimeState();
		state.status = "ready";
		state.jobId = builtinJobId;
		state.jobCounter = 1;
		state.ready = {
			...readyJob({ snapshotLeafId: "u2" }),
			jobId: builtinJobId,
			snapshotLeafId: "u2",
		};
		let abortCalls = 0;
		let compactTriggered = 0;
		const signal = new AbortController().signal;

		const applied = applyReadyCompaction(
			{
				...asyncJobContext(compactableEntries(), 800),
				isIdle: () => false,
				hasPendingMessages: () => false,
				signal,
				abort: () => abortCalls++,
			},
			state,
			asyncJobDeps({ triggerCompaction: () => compactTriggered++ }),
		);

		expect(applied).toBe(false);
		expect(abortCalls).toBe(0);
		expect(compactTriggered).toBe(0);
		expect(state.status).toBe("ready");
	});

	test("does not trigger Pi compaction when queued messages are pending", async () => {
		const state = createRuntimeState();
		let compactTriggered = 0;

		startAsyncJobWithDeps(
			{
				...asyncJobContext(compactableEntries()),
				isIdle: () => true,
				hasPendingMessages: () => true,
			},
			state,
			asyncJobDeps({ triggerCompaction: () => compactTriggered++ }),
		);
		await Promise.resolve();

		expect(state.status).toBe("ready");
		expect(compactTriggered).toBe(0);
	});

	test("manual force triggers Pi compaction when a reusable ready job already exists", () => {
		const state = createRuntimeState();
		state.status = "ready";
		state.jobId = builtinJobId;
		state.jobCounter = 1;
		state.ready = {
			...readyJob({ snapshotLeafId: "u2" }),
			jobId: builtinJobId,
			snapshotLeafId: "u2",
		};
		let compactTriggered = 0;

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries(), 100),
			state,
			asyncJobDeps({ triggerCompaction: () => compactTriggered++ }),
			{ force: true },
		);

		expect(compactTriggered).toBe(1);
	});
});
