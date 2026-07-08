import { expect } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
// test-only parity sentinel: Pi does not publicly export prepareCompaction/estimateContextTokens.
// if this private path breaks, update the sentinel or switch to a public export.
import {
	estimateContextTokens as estimatePiContextTokens,
	prepareCompaction as preparePiCompaction,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { prepareAsyncCompaction } from "../src/preparation";
import { timestamp } from "./entry-fixtures";
import { settings } from "./context-fixtures";

export { estimatePiContextTokens, preparePiCompaction };

export function expectAsyncPreparationToMatchPi(
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

export function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function textBlocksFromContent(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		const fields = recordFromUnknown(block);
		return fields?.type === "text" && typeof fields.text === "string" ? [fields.text] : [];
	});
}

export function textBlocksFromMessage(message: unknown): string[] {
	return textBlocksFromContent(recordFromUnknown(message)?.content);
}

function deterministicSummaryText(messages: readonly unknown[]): string {
	const text = messages
		.flatMap((message) => {
			if (!message || typeof message !== "object" || Array.isArray(message)) return [];
			return textBlocksFromContent((message as Record<string, unknown>).content);
		})
		.join("\n");
	return `deterministic:${text.length}:${text.slice(0, 120)}`;
}

export const deterministicStreamFn: NonNullable<Parameters<typeof compact>[7]> = (_model, context) => {
	const stream = createAssistantMessageEventStream();
	stream.end({
		role: "assistant",
		content: [{ type: "text", text: deterministicSummaryText(context.messages) }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.parse(timestamp),
	});
	return stream;
};
