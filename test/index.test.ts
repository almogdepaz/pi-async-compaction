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
	settings,
	textBlocksFromMessage,
	timestamp,
	userEntry,
	validationEvent,
} from "./test-fixtures";

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve: () => resolve?.() };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}

describe("extension hooks", () => {
	test("registers manual compaction and explicit ChatGPT login without a separate status command", () => {
		const { commands } = extensionHarness();

		expect(commands.has("async-compact-now")).toBe(true);
		expect(commands.has("chatgpt-web-login")).toBe(true);
		expect(commands.has("async-compact-status")).toBe(false);
	});

	test("confirms direct Brave sign-in through Pi before login verification", async () => {
		const confirmations: Array<{ readonly title: string; readonly message: string }> = [];
		let confirmed: boolean | undefined;
		const { commands, notifyMessages, ctx } = extensionHarness({
			loginToChatGptWeb: async (_signal, dependencies) => {
				confirmed = await dependencies?.confirmLogin?.(new AbortController().signal);
			},
		});
		const login = commands.get("chatgpt-web-login");
		if (!login) throw new Error("chatgpt-web-login command was not registered");
		const ui = {
			...ctx.ui,
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return true;
			},
		};

		await login.handler("", { ...ctx, ui, signal: undefined } as unknown as ExtensionContext);
		expect(confirmed).toBeTrue();
		expect(confirmations).toEqual([{
			title: "ChatGPT sign-in complete?",
			message: "Finish signing in to ChatGPT in the dedicated Brave window, return to Pi, then confirm to verify the session.",
		}]);
		expect(notifyMessages).toEqual([
			"Sign in to ChatGPT in the dedicated Brave window, then return here to confirm.",
			"ChatGPT web login ready",
		]);
	});

	test("links and unlinks a supplied command signal to the owned login controller", async () => {
		const parent = new AbortController();
		let added = 0;
		let removed = 0;
		const parentSignal = {
			get aborted() { return parent.signal.aborted; },
			addEventListener: (...args: Parameters<AbortSignal["addEventListener"]>) => { added++; parent.signal.addEventListener(...args); },
			removeEventListener: (...args: Parameters<AbortSignal["removeEventListener"]>) => { removed++; parent.signal.removeEventListener(...args); },
		} as unknown as AbortSignal;
		let ownedSignal: AbortSignal | undefined;
		const { commands, notifyMessages, ctx } = extensionHarness({
			loginToChatGptWeb: (signal) => {
				ownedSignal = signal;
				return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("owned login aborted")), { once: true }));
			},
		});
		const login = commands.get("chatgpt-web-login");
		if (!login) throw new Error("chatgpt-web-login command was not registered");

		const command = login.handler("", { ...ctx, signal: parentSignal } as ExtensionContext);
		await flushMicrotasks();
		parent.abort();
		await flushMicrotasks();

		expect(ownedSignal?.aborted).toBeTrue();
		await command;
		expect({ added, removed }).toEqual({ added: 1, removed: 1 });
		expect(notifyMessages).toEqual([
			"Sign in to ChatGPT in the dedicated Brave window, then return here to confirm.",
			"ChatGPT web login failed: owned login aborted",
		]);
	});

	test("rejects a duplicate ChatGPT login instead of queueing another launch", async () => {
		const releaseLogin = deferred();
		let launches = 0;
		const { commands, notifyMessages, ctx } = extensionHarness({
			loginToChatGptWeb: async () => { launches++; await releaseLogin.promise; },
		});
		const login = commands.get("chatgpt-web-login");
		if (!login) throw new Error("chatgpt-web-login command was not registered");

		const first = login.handler("", { ...ctx, signal: undefined } as unknown as ExtensionContext);
		await flushMicrotasks();
		const second = login.handler("", { ...ctx, signal: undefined } as unknown as ExtensionContext);
		await flushMicrotasks();

		expect(launches).toBe(1);
		expect(notifyMessages).toEqual([
			"Sign in to ChatGPT in the dedicated Brave window, then return here to confirm.",
			"ChatGPT web login already in progress",
		]);
		releaseLogin.resolve();
		await Promise.all([first, second]);
		expect(notifyMessages).toEqual([
			"Sign in to ChatGPT in the dedicated Brave window, then return here to confirm.",
			"ChatGPT web login already in progress",
			"ChatGPT web login ready",
		]);
	});

	test("aborts active login on shutdown while preserving core shutdown invalidation", async () => {
		let runtimeState: import("../src/types").RuntimeState | undefined;
		let ownedSignal: AbortSignal | undefined;
		const { commands, handlers, notifyMessages, ctx } = extensionHarness({
			startAsyncJob: (_jobCtx, state) => {
				runtimeState = state;
				state.status = "pending";
				return "started";
			},
			loginToChatGptWeb: (signal) => {
				ownedSignal = signal;
				return new Promise((_, reject) => signal.addEventListener(
					"abort",
					() => reject(new Error("shutdown abort")),
					{ once: true },
				));
			},
		});
		const start = commands.get("async-compact-now");
		const login = commands.get("chatgpt-web-login");
		const shutdown = handlers.get("session_shutdown");
		if (!start || !login || !shutdown) throw new Error("expected login and shutdown lifecycle");
		await start.handler("", ctx);
		const command = login.handler("", { ...ctx, signal: undefined } as unknown as ExtensionContext);
		await flushMicrotasks();

		await shutdown({}, ctx);
		await flushMicrotasks();
		expect(ownedSignal?.aborted).toBeTrue();
		await command;
		expect(runtimeState?.status).toBe("stale");
		expect(notifyMessages).toContain("ChatGPT web login failed: shutdown abort");
	});

	test("reports explicit ChatGPT login failures without starting compaction", async () => {
		let starts = 0;
		const { commands, notifyMessages, ctx } = extensionHarness({
			loginToChatGptWeb: async () => { throw new Error("login timed out"); },
			startAsyncJob: () => { starts++; return "started"; },
		});
		const login = commands.get("chatgpt-web-login");
		if (!login) throw new Error("chatgpt-web-login command was not registered");

		await login.handler("", { ...ctx, signal: new AbortController().signal } as ExtensionContext);

		expect(starts).toBe(0);
		expect(notifyMessages).toEqual([
			"Sign in to ChatGPT in the dedicated Brave window, then return here to confirm.",
			"ChatGPT web login failed: login timed out",
		]);
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

	test("selects compaction mode when invoked without an argument", async () => {
		const selectCalls: Array<{ readonly title: string; readonly options: string[] }> = [];
		const { commands, notifyMessages, ctx } = extensionHarness({ getInitialMode: () => "normal" });
		const mode = commands.get("compaction-mode");
		if (!mode) throw new Error("expected mode command");
		const ui = {
			...ctx.ui,
			select: async (title: string, options: string[]) => {
				selectCalls.push({ title, options });
				return "async";
			},
		};

		await mode.handler("", { ...ctx, ui } as ExtensionContext);

		expect(selectCalls).toEqual([{ title: "Compaction mode", options: ["normal", "async"] }]);
		expect(notifyMessages).toEqual(["compaction mode set to async"]);
	});

	test("selects async backend when invoked without an argument and leaves state unchanged on cancellation", async () => {
		const { commands, notifyMessages, ctx } = extensionHarness({ getInitialBackend: () => "provider" });
		const backend = commands.get("async-compaction-backend");
		if (!backend) throw new Error("expected backend command");
		const ui = { ...ctx.ui, select: async () => undefined };

		await backend.handler("", { ...ctx, ui } as ExtensionContext);
		await backend.handler("web", ctx);

		expect(notifyMessages).toEqual(["async compaction backend set to web"]);
	});

	test("retains direct scripted configuration arguments and rejects missing or invalid non-UI input", async () => {
		const select = async (): Promise<string | undefined> => { throw new Error("selector must not run"); };
		const { commands, ctx } = extensionHarness({ getInitialMode: () => "normal" });
		const mode = commands.get("compaction-mode");
		const backend = commands.get("async-compaction-backend");
		if (!mode || !backend) throw new Error("expected configuration commands");
		const nonUi = { ...ctx, hasUI: false, ui: { ...ctx.ui, select } } as ExtensionContext;
		const messages: string[] = [];
		const originalLog = console.log;
		console.log = (message: string) => { messages.push(message); };
		try {
			await mode.handler("async", nonUi);
			await backend.handler("invalid", nonUi);
			await backend.handler("", nonUi);
		} finally {
			console.log = originalLog;
		}

		expect(messages).toEqual([
			"compaction mode set to async",
			"usage: /async-compaction-backend provider|web",
			"usage: /async-compaction-backend provider|web",
		]);
	});

	test("switches backend by invalidating pending work and clears its status", async () => {
		let state: import("../src/types").RuntimeState | undefined;
		const { commands, statusValues, ctx } = extensionHarness({
			startAsyncJob: (_jobCtx, runtimeState) => {
				state = runtimeState;
				runtimeState.status = "pending";
				runtimeState.jobId = "async-prefix-compaction:builtin-pi-compaction:1";
				return "started";
			},
		});
		const start = commands.get("async-compact-now");
		const switchBackend = commands.get("async-compaction-backend");
		if (!start || !switchBackend) throw new Error("expected backend commands");

		await start.handler("", { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext);
		await switchBackend.handler("provider", ctx);

		expect(state?.status).toBe("stale");
		expect(statusValues).toContain(undefined);
	});

	test("normal mode blocks extension starts while preserving the selected backend", async () => {
		let starts = 0;
		const { commands, handlers, notifyMessages, ctx } = extensionHarness({
			getInitialMode: () => "normal",
			getInitialBackend: () => "provider",
			startAsyncJob: () => { starts++; return "started"; },
		});
		const start = commands.get("async-compact-now");
		const mode = commands.get("compaction-mode");
		const backend = commands.get("async-compaction-backend");
		const turnEnd = handlers.get("turn_end");
		if (!start || !mode || !backend || !turnEnd) throw new Error("expected compaction controls");

		await start.handler("", { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext);
		turnEnd({}, ctx);
		await backend.handler("provider", ctx);
		await mode.handler("async", ctx);

		expect(starts).toBe(0);
		expect(notifyMessages).toEqual([
			"async compaction not started: normal mode",
			"async compaction backend already provider",
			"compaction mode set to async",
		]);
	});

	test("switching compaction mode invalidates pending work and clears status", async () => {
		let state: import("../src/types").RuntimeState | undefined;
		const { commands, handlers, statusValues, ctx } = extensionHarness({
			startAsyncJob: (_jobCtx, runtimeState) => {
				state = runtimeState;
				runtimeState.status = "pending";
				runtimeState.jobId = "async-prefix-compaction:selected-compaction-backend:1";
				return "started";
			},
		});
		const start = commands.get("async-compact-now");
		const mode = commands.get("compaction-mode");
		const beforeCompact = handlers.get("session_before_compact");
		if (!start || !mode || !beforeCompact) throw new Error("expected mode commands");
		await start.handler("", { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext);
		await mode.handler("normal", ctx);
		expect(state?.status).toBe("stale");
		expect(statusValues).toContain(undefined);
		expect(await beforeCompact(validationEvent(), ctx)).toBeUndefined();
	});

	test("compares backends without starting or applying an async job", async () => {
		let startCalls = 0;
		let reportPath: string | undefined;
		const { commands, notifyMessages, ctx } = extensionHarness({
			startAsyncJob: () => {
				startCalls++;
				return "started";
			},
			runComparison: async ({ preparation }) => {
				expect(preparation.firstKeptEntryId).toBe("u2");
				return {
					provider: { status: "completed", markdown: "provider summary", durationMs: 1, outputLength: 16 },
					web: { status: "completed", markdown: "web summary", durationMs: 2, outputLength: 11 },
				};
			},
			writeComparisonReport: async () => ({
				directory: "/private/reports",
				htmlPath: "/private/reports/result.html",
				providerMarkdownPath: "/private/reports/provider.md",
				webMarkdownPath: "/private/reports/web.md",
				metadataPath: "/private/reports/metadata.json",
			}),
			openComparisonReport: async (path) => {
				reportPath = path;
			},
			getCompactionSettings: () => settings,
		});
		const compare = commands.get("async-compact-compare");
		if (!compare) throw new Error("expected comparison command");

		await compare.handler("", { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext);

		expect(startCalls).toBe(0);
		expect(reportPath).toBe("/private/reports/result.html");
		expect(notifyMessages).toEqual(["async compaction comparison written to /private/reports/result.html"]);
	});

	test("rejects a duplicate comparison and treats opener failure as a nonfatal warning", async () => {
		let releaseComparison: (() => void) | undefined;
		let comparisonCalls = 0;
		const { commands, notifyMessages, ctx } = extensionHarness({
			runComparison: async () => {
				comparisonCalls++;
				await new Promise<void>((resolve) => { releaseComparison = resolve; });
				return {
					provider: { status: "completed", markdown: "provider", durationMs: 1, outputLength: 8 },
					web: { status: "completed", markdown: "web", durationMs: 1, outputLength: 3 },
				};
			},
			writeComparisonReport: async () => ({ directory: "/private", htmlPath: "/private/result.html", providerMarkdownPath: "/private/p.md", webMarkdownPath: "/private/w.md", metadataPath: "/private/m.json" }),
			openComparisonReport: async () => { throw new Error("open unavailable"); },
			getCompactionSettings: () => settings,
		});
		const compare = commands.get("async-compact-compare");
		if (!compare) throw new Error("expected comparison command");
		const first = compare.handler("", { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext);
		await Promise.resolve();
		await compare.handler("", { ...manualCommandContext(), ui: ctx.ui } as ExtensionContext);
		releaseComparison?.();
		await first;

		expect(comparisonCalls).toBe(1);
		expect(notifyMessages).toEqual([
			"async compaction comparison already running",
			"async compaction comparison written to /private/result.html",
			"warning: async compaction comparison report could not be opened: /private/result.html (open unavailable)",
		]);
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
		expect(notifyMessages).toEqual(["Applied ready Async compaction"]);
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
