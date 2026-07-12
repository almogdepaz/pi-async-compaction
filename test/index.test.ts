import { describe, expect, spyOn, test } from "bun:test";
import type { CompactionResult, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { applyReadyCompaction, startAsyncJobWithDeps } from "../src/job";
import {
	assistantEntry,
	asyncJobContext,
	asyncJobDeps,
	compactableEntries,
	extensionHarness,
	manualCommandContext,
	ownAsyncMarker,
	recordFromUnknown,
	textBlocksFromMessage,
	timestamp,
	userEntry,
	validationEvent,
} from "./test-fixtures";

describe("extension hooks", () => {
	test("registers the manual command without a separate status command", () => {
		const { commands } = extensionHarness();

		expect(commands.has("async-compact-now")).toBe(true);
		expect(commands.has("async-compact-status")).toBe(false);
	});

	test("manual trigger command does not write status text to chat when a job starts", async () => {
		const { commands, notifyMessages, ctx } = extensionHarness();
		const command = commands.get("async-compact-now");
		if (!command) throw new Error("async-compact-now command was not registered");

		await command.handler("", { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext);

		expect(notifyMessages).toEqual([]);
	});

	test("manual trigger reports when async compaction is disabled", async () => {
		const previous = process.env.PI_ASYNC_PREFIX_COMPACTION;
		process.env.PI_ASYNC_PREFIX_COMPACTION = "0";
		try {
			const { commands, notifyMessages, ctx } = extensionHarness();
			const command = commands.get("async-compact-now");
			if (!command) throw new Error("async-compact-now command was not registered");

			await command.handler("", ctx);

			expect(notifyMessages).toEqual(["async compaction not started: disabled"]);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_ASYNC_PREFIX_COMPACTION;
			} else {
				process.env.PI_ASYNC_PREFIX_COMPACTION = previous;
			}
		}
	});

	test("manual trigger reports when a job is already pending", async () => {
		const { commands, notifyMessages, ctx } = extensionHarness();
		const command = commands.get("async-compact-now");
		if (!command) throw new Error("async-compact-now command was not registered");
		const commandCtx = { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext;

		await command.handler("", commandCtx);
		await command.handler("", commandCtx);

		expect(notifyMessages).toEqual(["async compaction not started: job already pending"]);
	});

	test("does not claim compactions from other extensions", () => {
		const { handlers, notifyMessages, ctx } = extensionHarness();
		const handler = handlers.get("session_compact");
		if (!handler) throw new Error("session_compact handler was not registered");

		handler(
			{
				fromExtension: true,
				compactionEntry: { details: { otherExtension: true } },
			},
			ctx,
		);

		expect(notifyMessages).toEqual([]);
	});

	test("defers notification until after Pi finishes its compaction render", async () => {
		const { handlers, notifyMessages, ctx } = extensionHarness();
		const handler = handlers.get("session_compact");
		if (!handler) throw new Error("session_compact handler was not registered");

		handler(
			{
				fromExtension: true,
				compactionEntry: { details: ownAsyncMarker() },
			},
			ctx,
		);

		expect(notifyMessages).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notifyMessages).toEqual(["Applied ready async compaction"]);
	});

	test("applies a ready async compaction at safe agent end", async () => {
		let compactTriggered = 0;
		const deps = asyncJobDeps({ triggerCompaction: (jobCtx) => jobCtx.compact() });
		const { handlers } = extensionHarness({
			applyReadyCompaction: (jobCtx, state) => applyReadyCompaction(jobCtx, state, deps),
			startAsyncJob: (jobCtx, state, options) => startAsyncJobWithDeps(jobCtx, state, deps, options),
		});
		const turnEndHandler = handlers.get("turn_end");
		const agentEndHandler = handlers.get("agent_end");
		if (!turnEndHandler) throw new Error("turn_end handler was not registered");
		if (!agentEndHandler) throw new Error("agent_end handler was not registered");

		const entries = compactableEntries();
		turnEndHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => false,
			hasPendingMessages: () => false,
			compact: () => compactTriggered++,
		} as ExtensionContext);
		await Promise.resolve();
		expect(compactTriggered).toBe(0);

		agentEndHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => true,
			hasPendingMessages: () => false,
			compact: () => compactTriggered++,
		} as ExtensionContext);
		expect(compactTriggered).toBe(0);

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(compactTriggered).toBe(1);
	});

	test("retries ready async compaction while an ended agent run is still settling", async () => {
		let compactTriggered = 0;
		let idle = false;
		const scheduledCallbacks: Array<() => void> = [];
		const captureTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
			if (typeof handler === "function") scheduledCallbacks.push(handler);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(captureTimeout);
		try {
			const deps = asyncJobDeps({ triggerCompaction: (jobCtx) => jobCtx.compact() });
			const { handlers } = extensionHarness({
				applyReadyCompaction: (jobCtx, state) => applyReadyCompaction(jobCtx, state, deps),
				startAsyncJob: (jobCtx, state, options) => startAsyncJobWithDeps(jobCtx, state, deps, options),
			});
			const turnEndHandler = handlers.get("turn_end");
			const agentEndHandler = handlers.get("agent_end");
			if (!turnEndHandler) throw new Error("turn_end handler was not registered");
			if (!agentEndHandler) throw new Error("agent_end handler was not registered");

			const entries = compactableEntries();
			turnEndHandler({}, {
				...asyncJobContext(entries),
				isIdle: () => false,
				hasPendingMessages: () => false,
				compact: () => compactTriggered++,
			} as ExtensionContext);
			await Promise.resolve();

			agentEndHandler({}, {
				...asyncJobContext(entries),
				isIdle: () => idle,
				hasPendingMessages: () => false,
				compact: () => compactTriggered++,
			} as ExtensionContext);
			scheduledCallbacks.shift()?.();
			expect(compactTriggered).toBe(0);

			idle = true;
			expect(scheduledCallbacks).toHaveLength(1);
			scheduledCallbacks.shift()?.();
			expect(compactTriggered).toBe(1);
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	test("defers ready async compaction at agent end when queued messages are pending", async () => {
		let compactTriggered = 0;
		const deps = asyncJobDeps({ triggerCompaction: (jobCtx) => jobCtx.compact() });
		const { handlers } = extensionHarness({
			applyReadyCompaction: (jobCtx, state) => applyReadyCompaction(jobCtx, state, deps),
			startAsyncJob: (jobCtx, state, options) => startAsyncJobWithDeps(jobCtx, state, deps, options),
		});
		const turnEndHandler = handlers.get("turn_end");
		const agentEndHandler = handlers.get("agent_end");
		if (!turnEndHandler) throw new Error("turn_end handler was not registered");
		if (!agentEndHandler) throw new Error("agent_end handler was not registered");

		const entries = compactableEntries();
		turnEndHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => false,
			hasPendingMessages: () => false,
			compact: () => compactTriggered++,
		} as ExtensionContext);
		await Promise.resolve();

		agentEndHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => true,
			hasPendingMessages: () => true,
			compact: () => compactTriggered++,
		} as ExtensionContext);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(compactTriggered).toBe(0);
	});

	test("collapses Pi compaction summary before handing off a ready job", async () => {
		const { handlers, toolExpansionValues, ctx } = extensionHarness({
			startAsyncJob: (jobCtx, state, options) => startAsyncJobWithDeps(jobCtx, state, asyncJobDeps(), options),
		});
		const turnEndHandler = handlers.get("turn_end");
		const beforeCompactHandler = handlers.get("session_before_compact");
		if (!turnEndHandler) throw new Error("turn_end handler was not registered");
		if (!beforeCompactHandler) throw new Error("session_before_compact handler was not registered");

		const entries = compactableEntries();
		turnEndHandler({}, asyncJobContext(entries));
		await Promise.resolve();

		const handoff = await beforeCompactHandler(validationEvent(), {
			...asyncJobContext(entries),
			hasUI: true,
			ui: ctx.ui,
		} as ExtensionContext);

		expect(handoff).toEqual({ compaction: expect.objectContaining({ summary: "async summary" }) });
		expect(toolExpansionValues).toEqual([false]);
	});

	test("hands off compaction that lets Pi rebuild context without gaps through appended tail", async () => {
		const { handlers } = extensionHarness({
			startAsyncJob: (jobCtx, state, options) => startAsyncJobWithDeps(jobCtx, state, asyncJobDeps(), options),
		});
		const turnEndHandler = handlers.get("turn_end");
		const beforeCompactHandler = handlers.get("session_before_compact");
		if (!turnEndHandler) throw new Error("turn_end handler was not registered");
		if (!beforeCompactHandler) throw new Error("session_before_compact handler was not registered");

		const snapshotEntries = compactableEntries();
		turnEndHandler({}, asyncJobContext(snapshotEntries));
		await Promise.resolve();

		const currentEntries = [
			...snapshotEntries,
			assistantEntry("a2", "u2", "assistant appended after async start"),
			userEntry("u3", "a2", "user appended after async start"),
		];
		const handoff = await beforeCompactHandler(validationEvent(), asyncJobContext(currentEntries));
		if (!handoff || typeof handoff !== "object" || !("compaction" in handoff)) {
			throw new Error("expected async compaction handoff");
		}
		const compaction = (handoff as { readonly compaction: CompactionResult }).compaction;
		const appliedCompaction: SessionEntry = {
			type: "compaction",
			id: "c1",
			parentId: currentEntries[currentEntries.length - 1]?.id ?? null,
			timestamp,
			summary: compaction.summary,
			firstKeptEntryId: compaction.firstKeptEntryId,
			tokensBefore: compaction.tokensBefore,
			details: compaction.details,
			fromHook: true,
		};

		const rebuiltMessages = buildSessionContext([...currentEntries, appliedCompaction]).messages;
		const summaryMessage = recordFromUnknown(rebuiltMessages[0]);
		const rawTextMessages = rebuiltMessages.flatMap(textBlocksFromMessage);

		expect(summaryMessage?.role).toBe("compactionSummary");
		expect(summaryMessage?.summary).toBe("async summary");
		expect(rawTextMessages).toEqual([
			"raw tail starts here",
			"assistant appended after async start",
			"user appended after async start",
		]);
	});

});
