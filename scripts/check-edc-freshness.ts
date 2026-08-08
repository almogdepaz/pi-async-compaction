import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkEdcFreshness } from "./edc-freshness";

const manifest = JSON.parse(readFileSync("edc-context/manifest.json", "utf8")) as unknown;
const runGit = (args: readonly string[]): boolean => {
	try {
		execFileSync("git", [...args], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
const changedPaths = (sourceCommit: string): readonly string[] => {
	const output = execFileSync("git", ["diff", "--name-only", `${sourceCommit}..HEAD`], { encoding: "utf8" });
	return output.trim().split("\n").filter(Boolean);
};

const failures = checkEdcFreshness(manifest, {
	sourceCommitExists: (sourceCommit) => runGit(["cat-file", "-e", `${sourceCommit}^{commit}`]),
	isAncestor: (sourceCommit) => runGit(["merge-base", "--is-ancestor", sourceCommit, "HEAD"]),
	changedPaths,
});
if (failures.length > 0) {
	for (const failure of failures) console.error(`EDC freshness: ${failure}`);
	process.exitCode = 1;
}
