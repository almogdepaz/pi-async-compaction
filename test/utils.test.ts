import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAsyncCompactionMarker, getCompactionSettings, getRetrySettings, getThinkingLevel } from "../src/utils";
import { ownAsyncMarker } from "./test-fixtures";

const timestamp = "2026-08-12T00:00:00.000Z";

describe("Pi settings", () => {
	test("ignores project compaction and retry settings when the project is untrusted", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-compaction-retry-settings-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const projectSettingsDir = join(cwd, ".pi");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			await mkdir(agentDir, { recursive: true });
			await mkdir(projectSettingsDir, { recursive: true });
			await writeFile(
				join(agentDir, "settings.json"),
				JSON.stringify({
					compaction: { enabled: true, reserveTokens: 12_345, keepRecentTokens: 2_345 },
					retry: { enabled: false, maxRetries: 2, baseDelayMs: 300 },
				}),
			);
			await writeFile(
				join(projectSettingsDir, "settings.json"),
				JSON.stringify({
					compaction: { enabled: false, reserveTokens: 99, keepRecentTokens: 9 },
					retry: { enabled: true, maxRetries: 9, baseDelayMs: 1 },
				}),
			);
			const ctx = {
				cwd,
				isProjectTrusted: () => false,
			} as unknown as ExtensionContext;

			expect(getCompactionSettings(ctx)).toEqual({ enabled: true, reserveTokens: 12_345, keepRecentTokens: 2_345 });
			expect(getRetrySettings(ctx)).toEqual({ enabled: false, maxRetries: 2, baseDelayMs: 300 });
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("thinking-level reconstruction", () => {
	test("preserves Pi's max thinking level", () => {
		const entries: SessionEntry[] = [
			{
				type: "thinking_level_change",
				id: "thinking-1",
				parentId: null,
				timestamp,
				thinkingLevel: "max",
			},
		];

		expect(String(getThinkingLevel(entries))).toBe("max");
	});

	test("accepts persisted async markers with max thinking", () => {
		const details = ownAsyncMarker();
		const marker = details.asyncPrefixCompaction as Record<string, unknown>;
		marker.thinkingLevel = "max";

		expect(String(getAsyncCompactionMarker(details)?.thinkingLevel)).toBe("max");
	});
});
