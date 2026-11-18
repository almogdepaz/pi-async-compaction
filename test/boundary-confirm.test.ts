import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { BUILTIN_ADAPTER_ID, EXTENSION_NAME, InvalidationReason, SUMMARY_PROMPT_VERSION } from "../src/constants";
import { confirmBoundaryCompaction } from "../src/job";
import { createRuntimeState } from "../src/runtime-state";
import type { JobCorrelation } from "../src/types";
import { asyncJobContext, assistantEntry, compactionEntry, ownAsyncMarker, userEntry } from "./test-fixtures";

const correlation: JobCorrelation = {
	adapterId: BUILTIN_ADAPTER_ID,
	jobId: `${EXTENSION_NAME}:${BUILTIN_ADAPTER_ID}:1`,
	promptVersion: SUMMARY_PROMPT_VERSION,
};

function proposedState(leafId: string | null) {
	const state = createRuntimeState();
	state.lastHandedOff = correlation;
	state.boundaryProposal = { ...correlation, leafId };
	return state;
}

/** An earlier process can persist a compaction with the same job id, because jobCounter restarts at 1. */
function branchWithOlderMatchingCompaction(): SessionEntry[] {
	return [
		userEntry("u1", null, "first"),
		assistantEntry("a1", "u1", "first answer"),
		compactionEntry("c0", "a1", true, ownAsyncMarker()),
		userEntry("u2", "c0", "second"),
		assistantEntry("a2", "u2", "second answer"),
	];
}

describe("confirmBoundaryCompaction", () => {
	test("confirms a matching compaction appended after the proposal leaf", () => {
		const state = proposedState("a2");
		const branch = [...branchWithOlderMatchingCompaction(), compactionEntry("c1", "a2", true, ownAsyncMarker())];

		expect(confirmBoundaryCompaction(asyncJobContext(branch), state)).toEqual(correlation);
		expect(state.boundaryProposal).toBeUndefined();
		expect(state.status).toBe("idle");
		expect(state.error).toBeUndefined();
	});

	test("does not confirm from an older matching compaction before the proposal leaf", () => {
		const state = proposedState("a2");

		expect(confirmBoundaryCompaction(asyncJobContext(branchWithOlderMatchingCompaction()), state)).toBeUndefined();
		expect(state.boundaryProposal).toBeUndefined();
		expect(state.lastHandedOff).toBeUndefined();
		expect(state.status).toBe("failed");
		expect(state.reason).toBe(InvalidationReason.FAILED);
		expect(state.error).toBe("apply failed: turn boundary compaction was not persisted");
	});

	test("records a failure when the proposal leaf left the branch", () => {
		const state = proposedState("missing-leaf");
		const branch = [...branchWithOlderMatchingCompaction(), compactionEntry("c1", "a2", true, ownAsyncMarker())];

		expect(confirmBoundaryCompaction(asyncJobContext(branch), state)).toBeUndefined();
		expect(state.status).toBe("failed");
	});

	test("does nothing without a pending proposal", () => {
		const state = createRuntimeState();

		expect(confirmBoundaryCompaction(asyncJobContext(branchWithOlderMatchingCompaction()), state)).toBeUndefined();
		expect(state.status).toBe("idle");
	});
});
