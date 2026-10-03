import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { checkReleaseConsistency } from "../scripts/release-consistency";
import manifest from "../package.json";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const astraDocs = readFileSync(new URL("../docs/astra-remote-context.md", import.meta.url), "utf8");

test("stock Astra uses a distinct release identity with consistent installation documentation", () => {
	expect(manifest.version).not.toBe("0.1.9-astra.2");
	expect(readme).toContain(manifest.version);
	expect(astraDocs).toContain(manifest.version);
	expect(checkReleaseConsistency({ version: manifest.version, tagsAtHead: execFileSync("git", ["tag", "--points-at", "HEAD"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim().split("\n"), changelog, readme })).toEqual([]);
});

test("stock Astra package pins its stock peers and does not ship a legacy host patch", () => {
	expect(Object.values(manifest.peerDependencies)).toEqual(["1.0.0", "1.0.0", "1.0.0"]);
	for (const name of Object.keys(manifest.peerDependencies)) {
		expect(manifest.devDependencies[name as keyof typeof manifest.devDependencies]).toBe("1.0.0");
	}
	expect(astraDocs).toContain("stock pi `1.0.0`");
	expect(readme).toContain("stock Pi `1.0.0`");
	expect(manifest.files.filter((path) => path.startsWith("patches/") || path.endsWith(".patch"))).toEqual([]);
});
