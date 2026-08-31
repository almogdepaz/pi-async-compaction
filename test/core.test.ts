import { describe, expect, test } from "bun:test";
import type { CompactionResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAsyncCompaction } from "../src/core";
import type { AsyncCompactionLifecycleEvent } from "../src/core";
import { createBuiltinPiCompactionAdapter } from "../src/adapter";
import type { AsyncCompactionAdapter } from "../src/adapter";
import { startAsyncJobWithDeps } from "../src/job";
import type { RuntimeState, Snapshot } from "../src/types";
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
			jobId: "async-prefix-compaction:package-adapter:1",
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

		const lifecycleEvents: AsyncCompactionLifecycleEvent[] = [];
		registerAsyncCompaction(pi, adapter, { commandName: false, onLifecycleEvent: (event) => lifecycleEvents.push(event) }, {
			startAsyncJob: (ctx, state, options) => startAsyncJobWithDeps(ctx, state, asyncJobDeps(), options),
		});
		expect(() => registerAsyncCompaction(pi, adapter)).toThrow("already registered");
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
					asyncPrefixCompaction: expect.objectContaining({
						adapterId: "package-adapter",
						jobId: "async-prefix-compaction:package-adapter:1",
						promptVersion: "adapter-test-v1",
					}),
				}),
			}),
		});
		expect(lifecycleEvents).toEqual([
			expect.objectContaining({ event: "started", adapterId: "package-adapter", jobId: "async-prefix-compaction:package-adapter:1" }),
			expect.objectContaining({ event: "ready", adapterId: "package-adapter", jobId: "async-prefix-compaction:package-adapter:1", durationMs: expect.any(Number) }),
			expect.objectContaining({ event: "handed_off", adapterId: "package-adapter", jobId: "async-prefix-compaction:package-adapter:1", durationMs: expect.any(Number) }),
		]);
	});

	test("records one correlated extension apply failure and clears terminal handoff state", () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const lifecycleEvents: AsyncCompactionLifecycleEvent[] = [];
		const pi = {
			on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(eventName, handler),
			registerCommand: () => undefined,
		} as unknown as ExtensionAPI;
		const deps = asyncJobDeps();
		let runtimeState: RuntimeState | undefined;
		registerAsyncCompaction(
			pi,
			createBuiltinPiCompactionAdapter(deps.buildAsyncCompactionResult),
			{ commandName: false, onLifecycleEvent: (event) => lifecycleEvents.push(event) },
			{
				startAsyncJob: (_ctx, state) => {
					runtimeState = state;
					return "disabled";
				},
			},
		);
		const turnEnd = handlers.get("turn_end");
		const compactFailed = handlers.get("session_compact_failed");
		if (!turnEnd || !compactFailed) throw new Error("expected compaction lifecycle handlers");

		const ctx = asyncJobContext(compactableEntries());
		turnEnd({}, ctx);
		if (!runtimeState) throw new Error("expected runtime state");
		const correlation = {
			adapterId: runtimeState.adapterId,
			jobId: "async-prefix-compaction:builtin-pi-compaction:1",
			promptVersion: "pi-compact-background-v1",
		};
		runtimeState.status = "idle";
		runtimeState.lastHandedOff = correlation;
		runtimeState.autoResumeAfterCompaction = correlation;
		const failureEvent = {
			type: "session_compact_failed",
			reason: "manual",
			aborted: true,
			willRetry: false,
			fromExtension: true,
		} as const;

		compactFailed({ ...failureEvent, fromExtension: false }, ctx);
		expect(lifecycleEvents).toEqual([]);
		compactFailed(failureEvent, ctx);
		compactFailed(failureEvent, ctx);

		expect(runtimeState).toMatchObject({
			status: "failed",
			lastHandedOff: undefined,
			autoResumeAfterCompaction: undefined,
		});
		expect(lifecycleEvents).toEqual([
			expect.objectContaining({
				event: "failed",
				jobId: correlation.jobId,
				phase: "apply",
				error: "apply failed: compaction aborted",
			}),
		]);
	});

	test("contains observer failures without blocking compaction", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const pi = {
			on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(eventName, handler),
			registerCommand: () => undefined,
		} as unknown as ExtensionAPI;
		const adapter: AsyncCompactionAdapter<Record<never, never>, { readonly text: string }> = {
			id: "observer-test",
			label: "observer test",
			prepare: () => ({}),
			createSnapshot: ({ jobId }) => ({
				jobId,
				sessionId: "session-1",
				snapshotLeafId: "u2",
				firstKeptEntryId: "u2",
				modelKey: "openai/test-model",
				thinkingLevel: "off",
				settingsKey: JSON.stringify(settings),
				promptVersion: "observer-test-v1",
			}),
			run: async () => ({ text: "observer summary" }),
			toCompaction: ({ result }): CompactionResult => ({
				summary: result.text,
				firstKeptEntryId: "u2",
				tokensBefore: 123,
			}),
		};
		const warnings: unknown[][] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args);
		try {
			registerAsyncCompaction(pi, adapter, { commandName: false, onLifecycleEvent: (event) => {
				if (event.event === "started") throw new Error("observer exploded");
			} }, {
				startAsyncJob: (ctx, state, options) => startAsyncJobWithDeps(ctx, state, asyncJobDeps(), options),
			});
			const turnEnd = handlers.get("turn_end");
			const beforeCompact = handlers.get("session_before_compact");
			if (!turnEnd || !beforeCompact) throw new Error("expected lifecycle handlers");
			turnEnd({}, asyncJobContext(compactableEntries()));
			await Promise.resolve();
			await Promise.resolve();
			expect(await beforeCompact(validationEvent(), asyncJobContext(compactableEntries()))).toEqual({
				compaction: expect.objectContaining({ summary: "observer summary" }),
			});
			expect(warnings).toEqual([["async compaction lifecycle observer failed", expect.any(Error)]]);
		} finally {
			console.warn = originalWarn;
		}
	});

	test("rejects unsafe adapter ids before registering hooks", () => {
		const unsafeAdapter = {
			id: "../unsafe",
			label: "unsafe adapter",
			prepare: () => undefined,
			createSnapshot: () => {
				throw new Error("must not create a snapshot");
			},
			run: async () => undefined,
			toCompaction: () => {
				throw new Error("must not convert a result");
			},
		} satisfies AsyncCompactionAdapter<unknown, unknown>;

		const pi = { on: () => undefined, registerCommand: () => undefined } as unknown as ExtensionAPI;
		expect(() => registerAsyncCompaction(pi, unsafeAdapter)).toThrow("unsafe adapter id");
	});
});
