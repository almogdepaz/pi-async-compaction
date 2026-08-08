import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkReleaseConsistency } from "./release-consistency";

interface PackageMetadata {
	readonly version: string;
}

const packageMetadata = JSON.parse(readFileSync("package.json", "utf8")) as PackageMetadata;
const failures = checkReleaseConsistency({
	version: packageMetadata.version,
	tagsAtHead: execFileSync("git", ["tag", "--points-at", "HEAD"], { encoding: "utf8" }).trim().split("\n").filter(Boolean),
	changelog: readFileSync("CHANGELOG.md", "utf8"),
	readme: readFileSync("README.md", "utf8"),
});

if (failures.length > 0) {
	for (const failure of failures) console.error(`release consistency: ${failure}`);
	process.exitCode = 1;
}
