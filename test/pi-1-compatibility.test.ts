import { describe, expect, test } from "bun:test";
import type { ContextEditEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { prepareAsyncCompaction } from "../src/preparation";
import { validateReadyJob } from "../src/validation";
import { assistantEntry, assistantToolEntry, expectAsyncPreparationToMatchPi, preparePiCompaction, readyJob, settings, timestamp, userEntry, validationContext, validationEvent } from "./test-fixtures";

function entries(): SessionEntry[] {
	return [userEntry("u1", null, "old prefix"), assistantEntry("a1", "u1", "old response"), userEntry("u2", "a1", "retained input"), assistantEntry("a2", "u2", "retained response")];
}

function edit(replacement: ContextEditEntry["replacement"]): ContextEditEntry {
	return { type: "context_edit", id: "edit", parentId: "a2", timestamp, targetId: "u1", replacement };
}

describe("Pi 1.x compatibility", () => {
	test.each([null, { content: "corrected input" }])("defers context-edited branches to Pi's projected synchronous compaction (%j)", (replacement) => {
		const branch = [...entries(), edit(replacement)];
		expect(preparePiCompaction(branch, settings)).toBeDefined();
		expect(prepareAsyncCompaction(branch, settings)).toBeUndefined();
	});

	test.each([null, { content: "corrected input" }])("rejects a summary prepared before a context edit (%j)", (replacement) => {
		const branch = [...entries(), edit(replacement)];
		expect(validateReadyJob(readyJob(), validationEvent(), validationContext(branch))).toBe("context_edited");
	});

	test("resumes async preparation after Pi compacts past the context edits", () => {
		const branch: SessionEntry[] = [
			...entries(), edit(null),
			userEntry("u3", "edit", "kept input"),
			{ type: "compaction", id: "compact", parentId: "u3", timestamp, summary: "native summary", firstKeptEntryId: "u3", tokensBefore: 100 },
			assistantEntry("a3", "compact", "new response"),
			userEntry("u4", "a3", "recent input"),
		];
		expect(prepareAsyncCompaction(branch, settings)).toBeDefined();
		expectAsyncPreparationToMatchPi(branch, settings);
	});

	test("matches Pi when the transcript contains a system message", () => {
		const branch: SessionEntry[] = [
			{ type: "message", id: "system", parentId: null, timestamp, message: { role: "system", content: [{ type: "text", text: "system instructions" }], timestamp: Date.parse(timestamp) } },
			...entries(),
		];
		expectAsyncPreparationToMatchPi(branch, settings);
	});

	test("tracks nested file operations from codemode tool results like Pi", () => {
		const branch: SessionEntry[] = [
			userEntry("u1", null, "inspect files"),
			assistantToolEntry("a1", "u1", "codemode", "unused"),
			{ type: "message", id: "t1", parentId: "a1", timestamp, message: {
				role: "toolResult", toolCallId: "a1-tool", toolName: "codemode", content: [{ type: "text", text: "done" }], isError: false, timestamp: Date.parse(timestamp),
				nestedCalls: { complete: true, calls: [
					{ id: "a1-tool/1", name: "read", arguments: { path: "nested-read.ts" }, status: "ok", durationMs: 1 },
					{ id: "a1-tool/2", name: "edit", arguments: { path: "nested-edit.ts" }, status: "ok", durationMs: 1 },
				] },
			} },
			userEntry("u2", "t1", "recent input"),
		];
		expectAsyncPreparationToMatchPi(branch, settings);
	});
});
