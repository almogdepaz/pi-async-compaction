import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { buildHistorySummaryRequest, buildTurnPrefixSummaryRequest } from "./chatgpt-prompt";
import { createChatGptWebTransport } from "./chatgpt-web";
import type { ChatGptTransport } from "./chatgpt-types";
import type { LocalCompactionPreparation } from "./types";

function computeFileLists(preparation: LocalCompactionPreparation): {
	readonly readFiles: string[];
	readonly modifiedFiles: string[];
} {
	const modified = new Set([...preparation.fileOps.edited, ...preparation.fileOps.written]);
	return {
		readFiles: [...preparation.fileOps.read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function formatFileOperations(readFiles: readonly string[], modifiedFiles: readonly string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

function requireTransportSummary(summary: string): string {
	const normalized = summary.trim();
	if (!normalized) throw new Error("ChatGPT returned an empty summary");
	return normalized;
}

/** Converts a ChatGPT web response into the same result shape Pi persists for compaction. */
export async function buildChatGptWebCompactionResult(
	preparation: LocalCompactionPreparation,
	signal: AbortSignal,
	transport: ChatGptTransport = createChatGptWebTransport(),
): Promise<CompactionResult> {
	let summary: string;
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
		const history = preparation.messagesToSummarize.length > 0
			? requireTransportSummary(await transport.complete(buildHistorySummaryRequest(preparation), signal))
			: "No prior history.";
		const turnPrefix = requireTransportSummary(await transport.complete(buildTurnPrefixSummaryRequest(preparation), signal));
		summary = `${history}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix}`;
	} else {
		summary = requireTransportSummary(await transport.complete(buildHistorySummaryRequest(preparation), signal));
	}

	const { readFiles, modifiedFiles } = computeFileLists(preparation);
	return {
		summary: `${summary}${formatFileOperations(readFiles, modifiedFiles)}`,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { readFiles, modifiedFiles },
	};
}
