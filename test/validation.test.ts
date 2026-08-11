import { describe, expect, test } from "bun:test";
import { validateReadyJob } from "../src/validation";
import { assistantEntry, readyJob, userEntry, validationContext, validationEvent } from "./test-fixtures";

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
		const entries = validEntries();
		const job = readyJob({
			result: {
				...readyJob().result,
				firstKeptEntryId: "u1",
			},
		});

		expect(validateReadyJob(job, validationEvent(), validationContext(entries))).toBe("first_kept_mismatch");
	});

	test.each([
		["session changes", readyJob({ sessionId: "other-session" }), validationEvent(), validationContext(validEntries()), "session_changed"],
		["model changes", readyJob({ modelKey: "other/model" }), validationEvent(), validationContext(validEntries()), "model_changed"],
		[
			"compaction settings change",
			readyJob(),
			{ ...validationEvent(), preparation: { ...validationEvent().preparation, settings: { ...validationEvent().preparation.settings, reserveTokens: 101 } } },
			validationContext(validEntries()),
			"settings_changed",
		],
		["thinking level changes", readyJob({ thinkingLevel: "low" }), validationEvent(), validationContext(validEntries()), "thinking_changed"],
		[
			"the first kept entry disappears",
			readyJob(),
			validationEvent(),
			validationContext([userEntry("u1", null, "old prefix"), assistantEntry("a1", "u1", "old assistant"), assistantEntry("a2", "a1", "snapshot leaf")]),
			"first_kept_missing",
		],
		[
			"the first kept entry becomes a tool result",
			readyJob(),
			validationEvent(),
			validationContext([userEntry("u1", null, "old prefix"), assistantEntry("a1", "u1", "old assistant"), toolResultEntry("u2", "a1"), assistantEntry("a2", "u2", "snapshot leaf")]),
			"first_kept_tool_result",
		],
		[
			"the first kept entry is after the snapshot",
			readyJob({ snapshotLeafId: "a1" }),
			validationEvent(),
			validationContext(validEntries()),
			"first_kept_after_snapshot",
		],
	] as const)("rejects ready jobs when %s", (_description, job, event, ctx, reason) => {
		expect(validateReadyJob(job, event, ctx)).toBe(reason);
	});
});

function validEntries() {
	return [
		userEntry("u1", null, "old prefix"),
		assistantEntry("a1", "u1", "old assistant"),
		userEntry("u2", "a1", "raw tail starts here"),
		assistantEntry("a2", "u2", "snapshot leaf"),
	];
}

function toolResultEntry(id: string, parentId: string) {
	const entry = userEntry(id, parentId, "tool result");
	return {
		...entry,
		message: {
			...entry.message,
			role: "toolResult",
		},
	} as unknown as ReturnType<typeof userEntry>;
}
