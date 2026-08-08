import { describe, expect, test } from "bun:test";
import { getStartRatio, getTimeoutMs, isEnabled } from "../src/utils";

describe("configuration helpers", () => {
	test("uses defaults for missing and invalid numeric settings", () => {
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS", undefined, () => {
			expect(getTimeoutMs()).toBe(300_000);
		});
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS", "not-a-number", () => {
			expect(getTimeoutMs()).toBe(300_000);
		});
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_START_RATIO", undefined, () => {
			expect(getStartRatio()).toBe(0.8);
		});
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_START_RATIO", "Infinity", () => {
			expect(getStartRatio()).toBe(0.8);
		});
	});

	test("clamps start ratios and floors non-negative timeout values", () => {
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_START_RATIO", "2", () => {
			expect(getStartRatio()).toBe(1);
		});
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_START_RATIO", "-0.5", () => {
			expect(getStartRatio()).toBe(0);
		});
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS", "12.9", () => {
			expect(getTimeoutMs()).toBe(12);
		});
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS", "-1", () => {
			expect(getTimeoutMs()).toBe(0);
		});
	});

	test("only literal zero disables async compaction", () => {
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION", "0", () => {
			expect(isEnabled()).toBeFalse();
		});
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION", "false", () => {
			expect(isEnabled()).toBeTrue();
		});
	});
});

function withEnvironment(name: string, value: string | undefined, run: () => void): void {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}
