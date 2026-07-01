import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { prepareAsyncCompaction, validateReadyJob } from "./index";

const timestamp = "2026-06-30T00:00:00.000Z";
const settings = {
	enabled: true,
	reserveTokens: 100,
	keepRecentTokens: 1,
};

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
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

function assistantEntry(id: string, parentId: string, text: string): SessionEntry {
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
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
		},
	};
}

function assistantToolEntry(id: string, parentId: string, toolName: string, path: string): SessionEntry {
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
});
