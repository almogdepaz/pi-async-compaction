import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
// test-only parity sentinel: Pi does not publicly export prepareCompaction/estimateContextTokens.
// if this private path breaks, update the sentinel or switch to a public export.
import {
	estimateContextTokens as estimatePiContextTokens,
	prepareCompaction as preparePiCompaction,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { InvalidationReason } from "./constants";
import { startAsyncJobWithDeps } from "./job";
import { getAbortInvalidationReason, createRuntimeState, formatRuntimeStatus } from "./runtime-state";
import asyncPrefixCompaction, { prepareAsyncCompaction, validateReadyJob } from "./index";
import { estimateContextUsageTokens, getTimeoutMs, settingsKey } from "./utils";

const timestamp = "2026-06-30T00:00:00.000Z";
const settings = {
	enabled: true,
	reserveTokens: 100,
	keepRecentTokens: 1,
};

function userEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.parse(timestamp),
		},
	};
}

function assistantEntry(id: string, parentId: string, text: string, totalTokens = 2): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "openai",
			model: "test-model",
			usage: {
				input: totalTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
		},
	};
}

function assistantToolEntry(id: string, parentId: string, toolName: string, path: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: `${id}-tool`,
					name: toolName,
					arguments: { path },
				},
			],
			api: "openai-completions",
			provider: "openai",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.parse(timestamp),
		},
	};
}

function compactionEntry(
	id: string,
	parentId: string,
	fromHook: boolean | undefined,
	details: unknown,
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp,
		summary: `${id} summary`,
		firstKeptEntryId: "u1",
		tokensBefore: 100,
		fromHook,
		details,
	};
}

function ownAsyncMarker(): Record<string, unknown> {
	return {
		asyncPrefixCompaction: {
			jobId: "async-prefix-compaction-1",
			snapshotLeafId: "a1",
			modelKey: "openai/test-model",
			thinkingLevel: "off",
			settingsKey: JSON.stringify(settings),
			promptVersion: "pi-compact-background-v1",
		},
	};
}

function testModel(contextWindow = 1_000): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 100,
	};
}

function validationEvent(customInstructions?: string): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		customInstructions,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		branchEntries: [],
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings,
		},
	};
}

function validationContext(entries: readonly SessionEntry[], contextWindow = 1_000): ExtensionContext {
	return {
		model: testModel(contextWindow),
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [...entries],
			getLeafId: () => entries[entries.length - 1]?.id ?? null,
		},
	} as ExtensionContext;
}

function asyncJobContext(entries: readonly SessionEntry[], usageTokens = 850, contextWindow = 1_000): ExtensionContext {
	return {
		cwd: process.cwd(),
		model: testModel(contextWindow),
		getContextUsage: () => ({ tokens: usageTokens, contextWindow }),
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [...entries],
			getLeafId: () => entries[entries.length - 1]?.id ?? null,
		},
	} as ExtensionContext;
}

function compactableEntries(): SessionEntry[] {
	return [
		userEntry("u1", null, "old prefix"),
		assistantEntry("a1", "u1", "old assistant"),
		userEntry("u2", "a1", "raw tail starts here"),
	];
}

function asyncJobDeps(overrides: Partial<Parameters<typeof startAsyncJobWithDeps>[2]> = {}): Parameters<typeof startAsyncJobWithDeps>[2] {
	return {
		buildAsyncCompactionResult: async (preparation) => ({
			summary: "async summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: { readFiles: [], modifiedFiles: [] },
		}),
		getCompactionSettings: () => settings,
		getStartRatio: () => 0.8,
		getTimeoutMs: () => 0,
		isEnabled: () => true,
		setCliStatus: () => undefined,
		triggerCompaction: () => undefined,
		...overrides,
	};
}

function extensionHarness(): {
	readonly handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	readonly commands: Map<string, { readonly handler: (args: string, ctx: ExtensionContext) => unknown }>;
	readonly notifyMessages: string[];
	readonly statusValues: Array<string | undefined>;
	readonly ctx: ExtensionContext;
} {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { readonly handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const pi = {
		on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(eventName, handler);
		},
		registerCommand: (name: string, command: { readonly handler: (args: string, ctx: ExtensionContext) => unknown }) => {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	const notifyMessages: string[] = [];
	const statusValues: Array<string | undefined> = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string) => {
				notifyMessages.push(message);
			},
			setStatus: (_key: string, text: string | undefined) => {
				statusValues.push(text);
			},
		},
	} as unknown as ExtensionContext;

	asyncPrefixCompaction(pi);

	return { handlers, commands, notifyMessages, statusValues, ctx };
}

function readyJob(overrides: Partial<Parameters<typeof validateReadyJob>[0]> = {}): Parameters<typeof validateReadyJob>[0] {
	return {
		jobId: "async-prefix-compaction-1",
		sessionId: "session-1",
		snapshotLeafId: "a2",
		firstKeptEntryId: "u2",
		modelKey: "openai/test-model",
		thinkingLevel: "off",
		settingsKey: JSON.stringify(settings),
		promptVersion: "pi-compact-background-v1",
		result: {
			summary: "summary",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
			details: {
				readFiles: [],
				modifiedFiles: [],
				asyncPrefixCompaction: {
					jobId: "async-prefix-compaction-1",
					snapshotLeafId: "a2",
					modelKey: "openai/test-model",
					thinkingLevel: "off",
					settingsKey: JSON.stringify(settings),
					promptVersion: "pi-compact-background-v1",
				},
			},
		},
		...overrides,
	};
}

function expectAsyncPreparationToMatchPi(
	entries: readonly SessionEntry[],
	compactionSettings: typeof settings,
): void {
	const asyncPreparation = prepareAsyncCompaction(entries, compactionSettings);
	const piPreparation = preparePiCompaction([...entries], compactionSettings);

	if (!piPreparation) {
		expect(asyncPreparation).toBeUndefined();
		return;
	}

	if (!asyncPreparation) {
		throw new Error("Async preparation missing when Pi prepared compaction");
	}

	expect(asyncPreparation.firstKeptEntryId).toBe(piPreparation.firstKeptEntryId);
	expect(asyncPreparation.messagesToSummarize.map((message) => message.role)).toEqual(
		piPreparation.messagesToSummarize.map((message) => message.role),
	);
	expect(asyncPreparation.turnPrefixMessages.map((message) => message.role)).toEqual(
		piPreparation.turnPrefixMessages.map((message) => message.role),
	);
	expect(asyncPreparation.isSplitTurn).toBe(piPreparation.isSplitTurn);
	expect(asyncPreparation.tokensBefore).toBe(piPreparation.tokensBefore);
	expect(asyncPreparation.previousSummary).toBe(piPreparation.previousSummary);
	expect([...asyncPreparation.fileOps.read].sort()).toEqual([...piPreparation.fileOps.read].sort());
	expect([...asyncPreparation.fileOps.written].sort()).toEqual([...piPreparation.fileOps.written].sort());
	expect([...asyncPreparation.fileOps.edited].sort()).toEqual([...piPreparation.fileOps.edited].sort());
}

describe("prepareAsyncCompaction", () => {
	test("inherits file operations from previous async compactions created by this extension", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "kept from previous compaction"),
			assistantToolEntry("a1", "u1", "read", "kept-before-previous.ts"),
			compactionEntry("c1", "a1", true, {
				readFiles: ["prior-read.ts"],
				modifiedFiles: ["prior-edit.ts"],
				...ownAsyncMarker(),
			}),
			userEntry("u2", "c1", "new work"),
			assistantToolEntry("a2", "u2", "edit", "new-edit.ts"),
			userEntry("u3", "a2", "recent tail"),
		];

		const preparation = prepareAsyncCompaction(entries, settings);

		expect(preparation?.fileOps.read.has("prior-read.ts")).toBe(true);
		expect(preparation?.fileOps.edited.has("prior-edit.ts")).toBe(true);
		expect(preparation?.fileOps.edited.has("new-edit.ts")).toBe(true);
	});

	test("inherits file operations from Pi-generated compactions", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "kept from previous compaction"),
			assistantToolEntry("a1", "u1", "read", "kept-before-previous.ts"),
			compactionEntry("c1", "a1", undefined, {
				readFiles: ["pi-read.ts"],
				modifiedFiles: ["pi-edit.ts"],
			}),
			userEntry("u2", "c1", "new work"),
			assistantToolEntry("a2", "u2", "write", "new-write.ts"),
			userEntry("u3", "a2", "recent tail"),
		];

		const preparation = prepareAsyncCompaction(entries, settings);

		expect(preparation?.fileOps.read.has("pi-read.ts")).toBe(true);
		expect(preparation?.fileOps.edited.has("pi-edit.ts")).toBe(true);
		expect(preparation?.fileOps.written.has("new-write.ts")).toBe(true);
	});

	test("does not inherit arbitrary extension compaction file details", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "kept from previous compaction"),
			assistantToolEntry("a1", "u1", "read", "kept-before-previous.ts"),
			compactionEntry("c1", "a1", true, {
				readFiles: ["foreign-read.ts"],
				modifiedFiles: ["foreign-edit.ts"],
				otherExtension: true,
			}),
			userEntry("u2", "c1", "new work"),
			assistantToolEntry("a2", "u2", "edit", "new-edit.ts"),
			userEntry("u3", "a2", "recent tail"),
		];

		const preparation = prepareAsyncCompaction(entries, settings);

		expect(preparation?.fileOps.read.has("foreign-read.ts")).toBe(false);
		expect(preparation?.fileOps.edited.has("foreign-edit.ts")).toBe(false);
		expect(preparation?.fileOps.edited.has("new-edit.ts")).toBe(true);
	});

	test("keeps Pi split-turn semantics for oversized turns", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "do the large task"),
			assistantEntry("a1", "u1", "x".repeat(1_000)),
		];

		const preparation = prepareAsyncCompaction(entries, settings);

		expect(preparation?.isSplitTurn).toBe(true);
		expect(preparation?.firstKeptEntryId).toBe("a1");
		expect(preparation?.messagesToSummarize).toHaveLength(0);
		expect(preparation?.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);
	});

	test("uses Pi usage-aware token accounting for tokensBefore", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "short request"),
			assistantEntry("a1", "u1", "short response", 12_345),
		];

		const preparation = prepareAsyncCompaction(entries, settings);

		expect(preparation?.tokensBefore).toBe(12_345);
	});

	test("does not prepare a compaction when there is nothing to summarize", () => {
		const preparation = prepareAsyncCompaction([userEntry("u1", null, "short request")], {
			...settings,
			keepRecentTokens: 100_000,
		});

		expect(preparation).toBeUndefined();
	});
});

describe("Pi preparation parity sentinels", () => {
	test("matches Pi's normal preparation shape", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "old request"),
			assistantToolEntry("a1", "u1", "read", "old.ts"),
			userEntry("u2", "a1", "recent request"),
			assistantEntry("a2", "u2", "recent response"),
		];

		expectAsyncPreparationToMatchPi(entries, { ...settings, keepRecentTokens: 1 });
	});

	test("matches Pi's split-turn preparation shape", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "do the large task"),
			assistantEntry("a1", "u1", "x".repeat(1_000)),
		];

		expectAsyncPreparationToMatchPi(entries, settings);
	});

	test("matches Pi's previous-compaction preparation shape for Pi-generated compactions", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "kept from previous compaction"),
			assistantToolEntry("a1", "u1", "read", "kept-before-previous.ts"),
			compactionEntry("c1", "a1", undefined, {
				readFiles: ["pi-read.ts"],
				modifiedFiles: ["pi-edit.ts"],
			}),
			userEntry("u2", "c1", "new work"),
			assistantToolEntry("a2", "u2", "write", "new-write.ts"),
			userEntry("u3", "a2", "recent tail"),
		];

		expectAsyncPreparationToMatchPi(entries, { ...settings, keepRecentTokens: 1 });
	});

	test("matches Pi's no-op preparation behavior when no messages need summarizing", () => {
		const entries = [userEntry("u1", null, "short request")];
		const largeKeepRecentSettings = { ...settings, keepRecentTokens: 100_000 };

		expectAsyncPreparationToMatchPi(entries, largeKeepRecentSettings);
	});

	test("matches Pi's zero-usage fallback when estimating context tokens", () => {
		const messages = [
			assistantEntry("a1", "u1", "old usage", 12_345).message,
			userEntry("u2", "a1", "tail").message,
			assistantEntry("a2", "u2", "x", 0).message,
		];

		expect(estimateContextUsageTokens(messages)).toBe(estimatePiContextTokens(messages).tokens);
	});
});

describe("startAsyncJob lifecycle", () => {
	test("does not start when disabled", () => {
		const state = createRuntimeState();

		startAsyncJobWithDeps(asyncJobContext(compactableEntries()), state, asyncJobDeps({ isEnabled: () => false }));

		expect(state.status).toBe("idle");
		expect(state.jobId).toBeUndefined();
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
				setCliStatus: (_ctx, text) => statusValues.push(text),
			}),
		);

		expect(state.status).toBe("pending");
		expect(state.jobId).toBe("async-prefix-compaction-1");
		expect(statusValues).toEqual(["async_compaction ..."]);
	});

	test("starts a pending job below the async threshold when forced", () => {
		const state = createRuntimeState();
		const never = new Promise<never>(() => {});

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries(), 100),
			state,
			asyncJobDeps({ buildAsyncCompactionResult: () => never }),
			{ force: true },
		);

		expect(state.status).toBe("pending");
		expect(state.jobId).toBe("async-prefix-compaction-1");
	});

	test("clears cli status line when a background job becomes ready", async () => {
		const state = createRuntimeState();
		const statusValues: Array<string | undefined> = [];

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({ setCliStatus: (_ctx, text) => statusValues.push(text) }),
		);
		await Promise.resolve();

		expect(state.status).toBe("ready");
		expect(state.ready?.result.summary).toBe("async summary");
		expect(state.ready?.result.details?.asyncPrefixCompaction.jobId).toBe("async-prefix-compaction-1");
		expect(statusValues).toEqual(["async_compaction ...", undefined]);
	});

	test("triggers Pi compaction when a background job becomes ready", async () => {
		const state = createRuntimeState();
		let compactTriggered = 0;

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({ triggerCompaction: () => compactTriggered++ }),
		);
		await Promise.resolve();

		expect(compactTriggered).toBe(1);
	});

	test("manual force triggers Pi compaction when a reusable ready job already exists", () => {
		const state = createRuntimeState();
		state.status = "ready";
		state.jobId = "async-prefix-compaction-1";
		state.jobCounter = 1;
		state.ready = {
			...readyJob({ snapshotLeafId: "u2" }),
			jobId: "async-prefix-compaction-1",
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

	test("marks timeout aborts stale with a timeout reason", async () => {
		const state = createRuntimeState();

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({
				getTimeoutMs: () => 1,
				buildAsyncCompactionResult: (_preparation, _model, _ctx, _thinkingLevel, signal) =>
					new Promise((_, reject) => {
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					}),
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(state.status).toBe("stale");
		expect(state.reason).toBe(InvalidationReason.TIMEOUT);
	});

	test("manual force uses the configured timeout", async () => {
		const state = createRuntimeState();

		startAsyncJobWithDeps(
			asyncJobContext(compactableEntries()),
			state,
			asyncJobDeps({
				getTimeoutMs: () => 1,
				buildAsyncCompactionResult: (_preparation, _model, _ctx, _thinkingLevel, signal) =>
					new Promise((_, reject) => {
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					}),
			}),
			{ force: true },
		);
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(state.status).toBe("stale");
		expect(state.reason).toBe(InvalidationReason.TIMEOUT);
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

describe("extension hooks", () => {
	test("registers manual and status commands", () => {
		const { commands } = extensionHarness();

		expect(commands.has("async-compact-now")).toBe(true);
		expect(commands.has("async-compact-status")).toBe(true);
	});

	test("manual trigger command does not write status text to chat", async () => {
		const { commands, notifyMessages, ctx } = extensionHarness();
		const command = commands.get("async-compact-now");
		if (!command) throw new Error("async-compact-now command was not registered");

		await command.handler("", ctx);

		expect(notifyMessages).toEqual([]);
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
		expect(notifyMessages).toEqual(["Applied ready async prefix compaction"]);
	});

	test("status command reports the last applied async compaction", async () => {
		const { handlers, commands, notifyMessages, ctx } = extensionHarness();
		const compactHandler = handlers.get("session_compact");
		const statusCommand = commands.get("async-compact-status");
		if (!compactHandler) throw new Error("session_compact handler was not registered");
		if (!statusCommand) throw new Error("async-compact-status command was not registered");

		compactHandler(
			{
				fromExtension: true,
				compactionEntry: { details: ownAsyncMarker() },
			},
			ctx,
		);
		await statusCommand.handler("", ctx);

		expect(notifyMessages[0]).toContain("lastApplied: async-prefix-compaction-1");
	});
});

describe("configuration helpers", () => {
	test("defaults timeout to five minutes", () => {
		const previous = process.env.PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS;
		delete process.env.PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS;
		try {
			expect(getTimeoutMs()).toBe(300_000);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS;
			} else {
				process.env.PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS = previous;
			}
		}
	});
});

describe("runtime state helpers", () => {
	test("formats status text for non-ui command output", () => {
		const text = formatRuntimeStatus(
			{
				status: "ready",
				jobId: "async-prefix-compaction-1",
				ready: undefined,
				reason: InvalidationReason.TIMEOUT,
				error: "slow model",
				abortController: undefined,
				jobCounter: 1,
				lastAppliedJobId: "async-prefix-compaction-1",
			},
			{
				enabled: true,
				startRatio: 0.75,
				timeoutMs: 1234,
			},
		);

		expect(text).toContain("status: ready");
		expect(text).toContain("lastApplied: async-prefix-compaction-1");
		expect(text).toContain("reason: timeout");
		expect(text).toContain("timeoutMs: 1234");
	});

	test("reports timeout aborts distinctly from lifecycle cancellation", () => {
		expect(getAbortInvalidationReason(true)).toBe(InvalidationReason.TIMEOUT);
		expect(getAbortInvalidationReason(false)).toBe(InvalidationReason.CANCELLED);
	});
});

describe("validateReadyJob", () => {
	test("accepts a ready job when the snapshot leaf and raw tail are still on the current branch", () => {
		const entries = [
			userEntry("u1", null, "old prefix"),
			assistantEntry("a1", "u1", "old assistant"),
			userEntry("u2", "a1", "raw tail starts here"),
			assistantEntry("a2", "u2", "snapshot leaf"),
			userEntry("u3", "a2", "appended after snapshot"),
		];

		expect(validateReadyJob(readyJob(), validationEvent(), validationContext(entries))).toBeUndefined();
	});

	test("rejects custom compaction instructions", () => {
		const entries = [userEntry("u1", null, "old prefix"), userEntry("u2", "u1", "tail"), assistantEntry("a2", "u2", "leaf")];

		expect(validateReadyJob(readyJob(), validationEvent("focus on errors"), validationContext(entries))).toBe(
			"custom_instructions",
		);
	});

	test("rejects branches that no longer contain the snapshot leaf", () => {
		const entries = [userEntry("u1", null, "old prefix"), userEntry("u2", "u1", "tail"), assistantEntry("other", "u2", "leaf")];

		expect(validateReadyJob(readyJob(), validationEvent(), validationContext(entries))).toBe("snapshot_leaf_missing");
	});

	test("rejects ready jobs whose previewed post-apply context is too large", () => {
		const entries = [
			userEntry("u1", null, "old prefix"),
			assistantEntry("a1", "u1", "old assistant"),
			userEntry("u2", "a1", "raw tail starts here"),
			assistantEntry("a2", "u2", "snapshot leaf"),
			userEntry("u3", "a2", "x".repeat(2_000)),
		];

		expect(validateReadyJob(readyJob(), validationEvent(), validationContext(entries, 120))).toBe("too_large");
	});

	test("rejects ready jobs when the result first kept entry differs from the snapshot", () => {
		const entries = [
			userEntry("u1", null, "old prefix"),
			assistantEntry("a1", "u1", "old assistant"),
			userEntry("u2", "a1", "raw tail starts here"),
			assistantEntry("a2", "u2", "snapshot leaf"),
		];
		const job = readyJob({
			result: {
				...readyJob().result,
				firstKeptEntryId: "u1",
			},
		});

		expect(validateReadyJob(job, validationEvent(), validationContext(entries))).toBe("first_kept_mismatch");
	});
});
