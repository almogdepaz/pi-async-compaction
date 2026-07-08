import { readFileSync } from "node:fs";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export const timestamp = "2026-06-30T00:00:00.000Z";

export function userEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
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

export function assistantEntry(id: string, parentId: string, text: string, totalTokens = 2): SessionMessageEntry {
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

export function assistantToolEntry(id: string, parentId: string, toolName: string, path: string): SessionMessageEntry {
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

export function compactionEntry(
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

export function compactableEntries(): SessionEntry[] {
	return [
		userEntry("u1", null, "old prefix"),
		assistantEntry("a1", "u1", "old assistant"),
		userEntry("u2", "a1", "raw tail starts here"),
	];
}

export function realLongEdcEntries(): SessionEntry[] {
	const fixtureUrl = new URL("../test-fixtures/edc-real-long-session.jsonl", import.meta.url);
	return readFileSync(fixtureUrl, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown)
		.filter((entry): entry is SessionEntry => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
			return (entry as Record<string, unknown>).type !== "session";
		});
}
