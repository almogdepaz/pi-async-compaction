import { describe, expect, test } from "bun:test";
import { checkReleaseConsistency } from "../scripts/release-consistency";

const version = "0.1.8";

describe("checkReleaseConsistency", () => {
	test("accepts an untagged unreleased version installed from main", () => {
		expect(checkReleaseConsistency({
			version,
			tagsAtHead: [],
			changelog: "# changelog\n\n## 0.1.8 — unreleased\n",
			readme: "pi install git:github.com/almogdepaz/pi-async-compaction@main",
		})).toEqual([]);
	});

	test("accepts release preparation before the matching Git tag exists", () => {
		expect(checkReleaseConsistency({
			version,
			tagsAtHead: [],
			changelog: "# changelog\n\n## 0.1.8 — 2026-08-31\n",
			readme: "pi install git:github.com/almogdepaz/pi-async-compaction@v0.1.8",
		})).toEqual([]);
	});

	test("accepts a tagged release with a dated changelog and matching Git tag", () => {
		expect(checkReleaseConsistency({
			version,
			tagsAtHead: ["v0.1.8"],
			changelog: "# changelog\n\n## 0.1.8 — 2026-08-31\n",
			readme: "pi install git:github.com/almogdepaz/pi-async-compaction@v0.1.8",
		})).toEqual([]);
	});

	test("accepts a tagged prerelease with matching release metadata", () => {
		const prereleaseVersion = "0.1.9-astra.0";
		expect(checkReleaseConsistency({
			version: prereleaseVersion,
			tagsAtHead: [`v${prereleaseVersion}`],
			changelog: `# changelog\n\n## ${prereleaseVersion} — 2026-09-10\n`,
			readme: `PI_CODING_AGENT_DIR=/tmp/astra node packages/coding-agent/dist/cli.js install git:github.com/almogdepaz/pi-async-compaction@v${prereleaseVersion}`,
		})).toEqual([]);
	});

	test("rejects numeric prerelease identifiers with leading zeroes", () => {
		expect(checkReleaseConsistency({
			version: "1.2.3-01",
			tagsAtHead: [],
			changelog: "# changelog\n\n## 1.2.3-01 — unreleased\n",
			readme: "pi install git:github.com/almogdepaz/pi-async-compaction@main",
		})).toEqual(["package.json version must be an exact semantic version"]);
	});

	test("rejects tagged releases that retain unreleased installation metadata", () => {
		expect(checkReleaseConsistency({
			version,
			tagsAtHead: ["v0.1.8"],
			changelog: "# changelog\n\n## 0.1.8 — unreleased\n",
			readme: "pi install git:github.com/almogdepaz/pi-async-compaction@main",
		})).toEqual(expect.arrayContaining([
			expect.stringContaining("dated"),
			expect.stringContaining("@v0.1.8"),
		]));
	});
});
