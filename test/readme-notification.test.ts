import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("documents the built-in adapter's applied notification", () => {
	const readme = readFileSync("README.md", "utf8");

	expect(readme).toContain("Applied ready ChatGPT web compaction");
	expect(readme).not.toContain("Applied ready async compaction");
});
