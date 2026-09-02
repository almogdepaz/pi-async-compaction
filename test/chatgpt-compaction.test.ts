import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChatGptWebCompactionAdapter } from "../src/adapter";
import { buildChatGptWebCompactionResult } from "../src/chatgpt-compaction";
import { buildHistorySummaryRequest } from "../src/chatgpt-prompt";
import {
	convertRenderedAssistantMarkdownToMarkdown,
	extractCompletedAssistantResponse,
	getChatGptResponseFailure,
	hasAuthenticatedChatGptSession,
} from "../src/chatgpt-web";
import type { ChatGptTransport } from "../src/chatgpt-types";
import type { LocalCompactionPreparation } from "../src/types";
import { asyncJobContext, compactableEntries, settings } from "./test-fixtures";

function preparation(overrides: Partial<LocalCompactionPreparation> = {}): LocalCompactionPreparation {
	return {
		firstKeptEntryId: "u2",
		messagesToSummarize: [{ role: "user", content: "summarize this", timestamp: 1 }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 123,
		previousSummary: undefined,
		fileOps: {
			read: new Set(["read-only.ts", "modified.ts"]),
			written: new Set(["written.ts"]),
			edited: new Set(["modified.ts"]),
		},
		settings,
		...overrides,
	};
}

function transportWith(responses: readonly string[]): ChatGptTransport {
	let index = 0;
	return {
		complete: async () => {
			const response = responses[index++];
			if (response === undefined) throw new Error("unexpected request");
			return response;
		},
	};
}

describe("chatgpt web compaction", () => {
	test("builds Pi-compatible history prompts from converted serialized conversation", () => {
		const request = buildHistorySummaryRequest(preparation({ previousSummary: "existing checkpoint" }));

		expect(request.prompt).toContain("<conversation>\n[User]: summarize this\n</conversation>");
		expect(request.prompt).toContain("<previous-summary>\nexisting checkpoint\n</previous-summary>");
		expect(request.prompt).toContain("## Goal");
	});

	test("returns a normal compaction result with Pi file-list semantics", async () => {
		const result = await buildChatGptWebCompactionResult(
			preparation(),
			new AbortController().signal,
			transportWith(["## Goal\nfinish it"]),
		);

		expect(result).toEqual({
			summary: "## Goal\nfinish it\n\n<read-files>\nread-only.ts\n</read-files>\n\n<modified-files>\nmodified.ts\nwritten.ts\n</modified-files>",
			firstKeptEntryId: "u2",
			tokensBefore: 123,
			details: {
			readFiles: ["read-only.ts"],
			modifiedFiles: ["modified.ts", "written.ts"],
		},
		});
	});

	test("summarizes split history and turn prefixes as one Pi-compatible checkpoint", async () => {
		const result = await buildChatGptWebCompactionResult(
			preparation({
				isSplitTurn: true,
				messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
				turnPrefixMessages: [{ role: "user", content: "current turn", timestamp: 2 }],
			}),
			new AbortController().signal,
			transportWith(["history summary", "turn prefix summary"]),
		);

		expect(result.summary).toContain("history summary\n\n---\n\n**Turn Context (split turn):**\n\nturn prefix summary");
	});

	test("rejects an empty transport summary before adding file tags", async () => {
		await expect(buildChatGptWebCompactionResult(
			preparation(),
			new AbortController().signal,
			transportWith([" \n\t "]),
		)).rejects.toThrow("ChatGPT returned an empty summary");
	});

	test("accepts only a structured authenticated ChatGPT session", () => {
		expect(hasAuthenticatedChatGptSession({ user: { id: "account-1" } })).toBe(true);
		expect(hasAuthenticatedChatGptSession({ user: null })).toBe(false);
		expect(hasAuthenticatedChatGptSession({ user: { id: " " } })).toBe(false);
		expect(hasAuthenticatedChatGptSession({ login: "localized login", composer: true })).toBe(false);
		expect(hasAuthenticatedChatGptSession(undefined)).toBe(false);
	});

	test("extracts the completed response from page-local assistant text", () => {
		expect(extractCompletedAssistantResponse("\n## Goal\nfinish it\n")).toBe("## Goal\nfinish it");
	});

	test("converts rendered assistant markdown HTML without losing formatting", () => {
		const markdown = convertRenderedAssistantMarkdownToMarkdown(`
			<h2>Goal</h2>
			<p><em>preserve this</em></p>
			<ul><li>first item</li><li>second item</li></ul>
			<p><a href="https://example.com/docs">documentation</a></p>
			<pre><code class="language-ts">const answer = 42;</code></pre>
		`);

		expect(markdown).toContain("## Goal");
		expect(markdown).toContain("_preserve this_");
		expect(markdown).toContain("*   first item");
		expect(markdown).toContain("[documentation](https://example.com/docs)");
		expect(markdown).toContain("```ts\nconst answer = 42;\n```");
	});

	test("classifies ChatGPT error and truncated-generation responses as unusable", () => {
		expect(getChatGptResponseFailure("Something went wrong while generating the response")).toBe(
			"ChatGPT failed to generate a complete response",
		);
		expect(getChatGptResponseFailure("Continue generating")).toBe(
			"ChatGPT response incomplete; generation must be continued",
		);
	});

	test("propagates browser transport failures without provider-auth fallback", async () => {
		const transport: ChatGptTransport = {
			complete: async () => {
				throw new Error("ChatGPT rate limit reached");
			},
		};

		await expect(buildChatGptWebCompactionResult(preparation(), new AbortController().signal, transport))
			.rejects.toThrow("ChatGPT rate limit reached");
	});

	test("default adapter uses ChatGPT transport without resolving Pi model credentials", async () => {
		let authCalls = 0;
		const ctx = {
			...asyncJobContext(compactableEntries()),
			modelRegistry: {
				getApiKeyAndHeaders: async () => {
					authCalls++;
					throw new Error("Pi auth must not be used");
				},
			},
		} as unknown as ExtensionContext;
		const adapter = createChatGptWebCompactionAdapter(transportWith(["browser summary"]));
		const prepared = adapter.prepare({ ctx, settings });
		if (!prepared) throw new Error("expected prepared compaction");

		const result = await adapter.run({ ctx, prepared, signal: new AbortController().signal });

		expect(result.summary).toContain("browser summary");
		expect(authCalls).toBe(0);
	});
});
