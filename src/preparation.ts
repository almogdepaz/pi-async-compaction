import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, findCutPoint, getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import type { FileOperations, LocalCompactionPreparation, ResolvedCompactionSettings } from "./types";
import { estimateContextUsageTokens, getAsyncCompactionMarker, getStringArrayProperty, hasContextEdits } from "./utils";

function createFileOps(): FileOperations {
	return {
		read: new Set<string>(),
		written: new Set<string>(),
		edited: new Set<string>(),
	};
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	const calls = message.role === "toolResult"
		? message.nestedCalls?.calls ?? []
		: message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [];
	for (const call of calls) {
		const path = typeof call.arguments?.path === "string" ? call.arguments.path : undefined;
		if (!path) continue;

		switch (call.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message.role === "system" ? undefined : entry.message;
	}
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			details: entry.details,
			timestamp: Date.parse(entry.timestamp),
		};
	}
	if (entry.type === "branch_summary") {
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp: Date.parse(entry.timestamp),
		};
	}
	return undefined;
}

export function prepareAsyncCompaction(
	pathEntries: readonly SessionEntry[],
	settings: ResolvedCompactionSettings,
): LocalCompactionPreparation | undefined {
	if (hasContextEdits(pathEntries)) return undefined;
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1]?.type === "compaction") {
		return undefined;
	}

	const latestCompaction = getLatestCompactionEntry([...pathEntries]);
	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (latestCompaction) {
		previousSummary = latestCompaction.summary;
		const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === latestCompaction.firstKeptEntryId);
		const compactionIndex = pathEntries.findIndex((entry) => entry.id === latestCompaction.id);
		boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex + 1;
	}

	const cutPoint = findCutPoint([...pathEntries], boundaryStart, pathEntries.length, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry) {
		return undefined;
	}

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const message = entryToMessage(pathEntries[i]!);
		if (message) messagesToSummarize.push(message);
	}

	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const message = entryToMessage(pathEntries[i]!);
			if (message) turnPrefixMessages.push(message);
		}
	}

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	const fileOps = createFileOps();
	const shouldInheritCompactionDetails =
		latestCompaction && (!latestCompaction.fromHook || getAsyncCompactionMarker(latestCompaction.details));
	if (shouldInheritCompactionDetails) {
		for (const file of getStringArrayProperty(latestCompaction.details, "readFiles")) {
			fileOps.read.add(file);
		}
		for (const file of getStringArrayProperty(latestCompaction.details, "modifiedFiles")) {
			fileOps.edited.add(file);
		}
	}
	for (const message of [...messagesToSummarize, ...turnPrefixMessages]) {
		extractFileOpsFromMessage(message, fileOps);
	}

	return {
		firstKeptEntryId: firstKeptEntry.id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore: estimateContextUsageTokens(buildSessionContext([...pathEntries]).messages),
		previousSummary,
		fileOps,
		settings,
	};
}
