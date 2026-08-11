import { describe, expect, test } from "bun:test";
import { checkReleaseConsistency } from "../scripts/release-consistency";

const version = "0.1.7";

describe("checkReleaseConsistency", () => {
	test("accepts an untagged unreleased version installed from main", () => {
		expect(checkReleaseConsistency({
			version,
			tagsAtHead: [],
			changelog: "# changelog\n\n## 0.1.7 — unreleased\n",
			readme: "pi install git:github.com/almogdepaz/pi-async-compaction@main",
		})).toEqual([]);
	});

	test("accepts a tagged release with a dated changelog and matching Git tag", () => {
		expect(checkReleaseConsistency({
			version,
			tagsAtHead: ["v0.1.7"],
			changelog: "# changelog\n\n## 0.1.7 — 2026-08-08\n",
			readme: "pi install git:github.com/almogdepaz/pi-async-compaction@v0.1.7",
		})).toEqual([]);
	});

	test("rejects tagged releases that retain unreleased installation metadata", () => {
		expect(checkReleaseConsistency({
			version,
			tagsAtHead: ["v0.1.7"],
			changelog: "# changelog\n\n## 0.1.7 — unreleased\n",
			readme: "pi install git:github.com/almogdepaz/pi-async-compaction@main",
		})).toEqual(expect.arrayContaining([
			expect.stringContaining("dated"),
			expect.stringContaining("@v0.1.7"),
		]));
	});
});
