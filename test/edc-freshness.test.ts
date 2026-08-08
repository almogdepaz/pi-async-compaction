import { describe, expect, test } from "bun:test";
import { checkEdcFreshness } from "../scripts/edc-freshness";

const manifest = {
	sourceCommit: "source",
	modules: [{
		match: {
			exactFiles: ["README.md", "package.json"],
			prefixes: ["src/", "test/"],
		},
	}],
};
const validDependencies = {
	sourceCommitExists: () => true,
	isAncestor: () => true,
	changedPaths: () => [],
};

describe("checkEdcFreshness", () => {
	test("accepts a later context-only regeneration commit", () => {
		expect(checkEdcFreshness(manifest, {
		sourceCommitExists: () => true,
		isAncestor: () => true,
		changedPaths: () => ["edc-context/manifest.json", "edc-context/index.md"],
	})).toEqual([]);
	});

	test("rejects routed source files changed after the source commit", () => {
		expect(checkEdcFreshness(manifest, {
		sourceCommitExists: () => true,
		isAncestor: () => true,
		changedPaths: () => ["src/job.ts", "README.md", "edc-context/index.md"],
	})).toEqual(expect.arrayContaining([
		"EDC-routed source files changed since sourceCommit: README.md, src/job.ts",
		]));
	});

	test("rejects a missing, unresolved, or non-ancestor source commit", () => {
		expect(checkEdcFreshness({ ...manifest, sourceCommit: undefined }, validDependencies)).toEqual([
			"EDC manifest sourceCommit is missing",
		]);
		expect(checkEdcFreshness(manifest, { ...validDependencies, sourceCommitExists: () => false })).toEqual([
			"EDC manifest sourceCommit does not resolve to a commit",
		]);
		expect(checkEdcFreshness(manifest, { ...validDependencies, isAncestor: () => false })).toEqual([
			"EDC manifest sourceCommit is not an ancestor of HEAD",
		]);
	});

	test.each([
		["missing modules", { sourceCommit: "source" }, "EDC manifest must define at least one routing module"],
		["empty modules", { sourceCommit: "source", modules: [] }, "EDC manifest must define at least one routing module"],
		[
			"a missing match object",
			{ sourceCommit: "source", modules: [{}] },
			"EDC manifest module 0 match must be an object",
		],
		[
			"non-string routes",
			{ sourceCommit: "source", modules: [{ match: { exactFiles: ["README.md", 1], prefixes: ["src/"] } }] },
			"EDC manifest module 0 match.exactFiles must be an array of strings",
		],
		[
			"an empty route set",
			{ sourceCommit: "source", modules: [{ match: { exactFiles: [], prefixes: [] } }] },
			"EDC manifest module 0 must define at least one exact file or prefix",
		],
	] as const)("rejects %s", (_description, malformedManifest, failure) => {
		expect(checkEdcFreshness(malformedManifest, validDependencies)).toContain(failure);
	});
});
