import { describe, expect, test } from "bun:test";
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
		const { commands, notifyMessages, ctx } = extensionHarness({ startAsyncJob: () => "started" });
		const command = commands.get("async-compact-now");
		if (!command) throw new Error("async-compact-now command was not registered");

		await command.handler("", { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext);

		expect(notifyMessages).toEqual([]);
	});

	test("manual trigger reports when async compaction is disabled", async () => {
		const previous = process.env.PI_ASYNC_PREFIX_COMPACTION;
		process.env.PI_ASYNC_PREFIX_COMPACTION = "0";
		try {
			const { commands, notifyMessages, ctx } = extensionHarness({ startAsyncJob: () => "disabled" });
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
		let starts = 0;
		const { commands, notifyMessages, ctx } = extensionHarness({
			startAsyncJob: () => ++starts === 1 ? "started" : "already_pending",
		});
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

	test("does not claim a structurally valid marker from another adapter", async () => {
		const { handlers, notifyMessages, ctx } = extensionHarness();
		const handler = handlers.get("session_compact");
		if (!handler) throw new Error("session_compact handler was not registered");

		handler(
			{
				fromExtension: true,
				compactionEntry: {
					details: {
						asyncPrefixCompaction: {
							jobId: "async-prefix-compaction:builtin-pi-compaction:1",
							snapshotLeafId: "a1",
							modelKey: "openai/test-model",
							thinkingLevel: "off",
							settingsKey: JSON.stringify({ enabled: true, reserveTokens: 100, keepRecentTokens: 1 }),
							promptVersion: "pi-compact-background-v1",
							adapterId: "other-adapter",
						},
					},
				},
			},
			ctx,
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notifyMessages).toEqual([]);
	});

	test("does not claim an uncorrelated marker from its own adapter", async () => {
		const { handlers, notifyMessages, ctx } = extensionHarness();
		const handler = handlers.get("session_compact");
		if (!handler) throw new Error("session_compact handler was not registered");

		handler(
			{
				fromExtension: true,
				compactionEntry: {
					details: {
						asyncPrefixCompaction: {
							jobId: "async-prefix-compaction:builtin-pi-compaction:99",
							snapshotLeafId: "a1",
							modelKey: "openai/test-model",
							thinkingLevel: "off",
							settingsKey: JSON.stringify({ enabled: true, reserveTokens: 100, keepRecentTokens: 1 }),
							promptVersion: "pi-compact-background-v1",
							adapterId: "builtin-pi-compaction",
						},
					},
				},
			},
			ctx,
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notifyMessages).toEqual([]);
	});

	test("applies ready async compaction at agent settlement without agent-end polling", async () => {
		let compactTriggered = 0;
		const deps = asyncJobDeps({ triggerCompaction: (jobCtx) => jobCtx.compact() });
		const { handlers } = extensionHarness({
			applyReadyCompaction: (jobCtx, state) => applyReadyCompaction(jobCtx, state, deps),
			startAsyncJob: (jobCtx, state, options) =>
				startAsyncJobWithDeps(jobCtx, state, deps, { ...(options ?? { force: false }), adapter: undefined }),
		});
		const turnEndHandler = handlers.get("turn_end");
		const agentSettledHandler = handlers.get("agent_settled");
		if (!turnEndHandler) throw new Error("turn_end handler was not registered");
		if (!agentSettledHandler) throw new Error("agent_settled handler was not registered");

		const entries = compactableEntries();
		turnEndHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => false,
			hasPendingMessages: () => false,
			compact: () => compactTriggered++,
		} as ExtensionContext);
		await Promise.resolve();
		expect(compactTriggered).toBe(0);
		expect(handlers.has("agent_end")).toBe(false);

		agentSettledHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => true,
			hasPendingMessages: () => false,
			compact: () => compactTriggered++,
		} as ExtensionContext);

		expect(compactTriggered).toBe(1);
	});

	test("auto-resumes after a force-stopped async compaction is applied", async () => {
		const deps = asyncJobDeps({ triggerCompaction: (jobCtx) => jobCtx.compact() });
		const { handlers, notifyMessages, sentUserMessages, ctx } = extensionHarness({
			applyReadyCompaction: (jobCtx, state) => applyReadyCompaction(jobCtx, state, deps),
			startAsyncJob: (jobCtx, state, options) =>
				startAsyncJobWithDeps(jobCtx, state, deps, { ...(options ?? { force: false }), adapter: undefined }),
		});
		const turnEndHandler = handlers.get("turn_end");
		const beforeCompactHandler = handlers.get("session_before_compact");
		const compactHandler = handlers.get("session_compact");
		if (!turnEndHandler) throw new Error("turn_end handler was not registered");
		if (!beforeCompactHandler) throw new Error("session_before_compact handler was not registered");
		if (!compactHandler) throw new Error("session_compact handler was not registered");

		const entries = compactableEntries();
		let abortCalls = 0;
		let compactTriggered = 0;
		turnEndHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => false,
			hasPendingMessages: () => false,
			signal: new AbortController().signal,
			abort: () => abortCalls++,
			compact: () => compactTriggered++,
		} as ExtensionContext);
		await Promise.resolve();
		expect(abortCalls).toBe(1);
		expect(compactTriggered).toBe(1);

		const handoff = await beforeCompactHandler(validationEvent(), {
			...asyncJobContext(entries),
			hasUI: true,
			ui: ctx.ui,
		} as ExtensionContext);
		if (!handoff || typeof handoff !== "object" || !("compaction" in handoff)) {
			throw new Error("expected async compaction handoff");
		}
		const compaction = (handoff as { readonly compaction: CompactionResult }).compaction;

		compactHandler(
			{
				fromExtension: true,
				compactionEntry: { details: compaction.details },
			},
			ctx,
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notifyMessages).toEqual(["Applied ready ChatGPT web compaction"]);
		expect(sentUserMessages).toEqual(["continue"]);
	});

	test("does not auto-resume when user input arrives before deferred resume", async () => {
		const deps = asyncJobDeps({ triggerCompaction: (jobCtx) => jobCtx.compact() });
		const { handlers, sentUserMessages, ctx } = extensionHarness({
			applyReadyCompaction: (jobCtx, state) => applyReadyCompaction(jobCtx, state, deps),
			startAsyncJob: (jobCtx, state, options) =>
				startAsyncJobWithDeps(jobCtx, state, deps, { ...(options ?? { force: false }), adapter: undefined }),
		});
		const turnEndHandler = handlers.get("turn_end");
		const beforeCompactHandler = handlers.get("session_before_compact");
		const compactHandler = handlers.get("session_compact");
		if (!turnEndHandler || !beforeCompactHandler || !compactHandler) throw new Error("expected lifecycle handlers");

		const entries = compactableEntries();
		turnEndHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => false,
			hasPendingMessages: () => false,
			signal: new AbortController().signal,
			abort: () => undefined,
			compact: () => undefined,
		} as ExtensionContext);
		await Promise.resolve();

		const handoff = await beforeCompactHandler(validationEvent(), {
			...asyncJobContext(entries),
			hasUI: true,
			ui: ctx.ui,
		} as ExtensionContext);
		if (!handoff || typeof handoff !== "object" || !("compaction" in handoff)) {
			throw new Error("expected async compaction handoff");
		}
		const compaction = (handoff as { readonly compaction: CompactionResult }).compaction;
		let pendingMessages = false;

		compactHandler(
			{
				fromExtension: true,
				compactionEntry: { details: compaction.details },
			},
			{ ...ctx, hasPendingMessages: () => pendingMessages } as ExtensionContext,
		);
		pendingMessages = true;

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sentUserMessages).toEqual([]);
	});

	test("defers ready async compaction at agent settlement when queued messages are pending", async () => {
		let compactTriggered = 0;
		const deps = asyncJobDeps({ triggerCompaction: (jobCtx) => jobCtx.compact() });
		const { handlers } = extensionHarness({
			applyReadyCompaction: (jobCtx, state) => applyReadyCompaction(jobCtx, state, deps),
			startAsyncJob: (jobCtx, state, options) =>
				startAsyncJobWithDeps(jobCtx, state, deps, { ...(options ?? { force: false }), adapter: undefined }),
		});
		const turnEndHandler = handlers.get("turn_end");
		const agentSettledHandler = handlers.get("agent_settled");
		if (!turnEndHandler) throw new Error("turn_end handler was not registered");
		if (!agentSettledHandler) throw new Error("agent_settled handler was not registered");

		const entries = compactableEntries();
		turnEndHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => false,
			hasPendingMessages: () => false,
			compact: () => compactTriggered++,
		} as ExtensionContext);
		await Promise.resolve();

		agentSettledHandler({}, {
			...asyncJobContext(entries),
			isIdle: () => true,
			hasPendingMessages: () => true,
			compact: () => compactTriggered++,
		} as ExtensionContext);

		expect(compactTriggered).toBe(0);
	});

	test("collapses Pi compaction summary before handing off a ready job", async () => {
		const { handlers, toolExpansionValues, ctx } = extensionHarness({
			startAsyncJob: (jobCtx, state, options) =>
				startAsyncJobWithDeps(jobCtx, state, asyncJobDeps(), { ...(options ?? { force: false }), adapter: undefined }),
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
			startAsyncJob: (jobCtx, state, options) =>
				startAsyncJobWithDeps(jobCtx, state, asyncJobDeps(), { ...(options ?? { force: false }), adapter: undefined }),
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
