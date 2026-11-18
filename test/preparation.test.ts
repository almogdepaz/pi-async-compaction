import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { prepareAsyncCompaction } from "../src/preparation";
import {
	assistantEntry,
	assistantToolEntry,
	compactionEntry,
	ownAsyncMarker,
	settings,
	userEntry,
} from "./test-fixtures";

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

	test("does not summarize raw content that an active context edit omits", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "secret omitted request"),
			assistantEntry("a1", "u1", "x".repeat(1_000)),
			userEntry("u2", "a1", "kept request"),
			assistantEntry("a2", "u2", "y".repeat(1_000)),
			{ type: "context_edit", id: "e1", parentId: "a2", timestamp: new Date(0).toISOString(), targetId: "u1", replacement: null },
			userEntry("u3", "e1", "recent tail"),
		];

		// Pi's synchronous path prepares from the edited projection; the async path must not use raw entries.
		expect(prepareAsyncCompaction(entries, settings)).toBeUndefined();
	});

	test("does not prepare a compaction when there is nothing to summarize", () => {
		const preparation = prepareAsyncCompaction([userEntry("u1", null, "short request")], {
			...settings,
			keepRecentTokens: 100_000,
		});

		expect(preparation).toBeUndefined();
	});
});
