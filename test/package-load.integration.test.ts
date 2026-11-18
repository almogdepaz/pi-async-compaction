import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Pi loads the package entrypoint and registers its command and lifecycle hooks", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-async-package-load-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: [process.env.PI_ASYNC_TEST_PACKAGE_PATH ?? resolve(import.meta.dir, "..")],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "package load test",
			appendSystemPrompt: [],
		});
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		const extension = result.extensions[0];
		expect(extension?.commands.has("async-compact-now")).toBe(true);
		expect(extension?.handlers.has("session_before_compact")).toBe(true);
		expect(extension?.handlers.has("agent_settled")).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
