export interface EdcFreshnessDependencies {
	sourceCommitExists(sourceCommit: string): boolean;
	isAncestor(sourceCommit: string): boolean;
	changedPaths(sourceCommit: string): readonly string[];
}

export function checkEdcFreshness(manifest: unknown, deps: EdcFreshnessDependencies): string[] {
	const sourceCommit = getStringProperty(manifest, "sourceCommit");
	if (!sourceCommit) {
		return ["EDC manifest sourceCommit is missing"];
	}
	if (!deps.sourceCommitExists(sourceCommit)) {
		return ["EDC manifest sourceCommit does not resolve to a commit"];
	}
	if (!deps.isAncestor(sourceCommit)) {
		return ["EDC manifest sourceCommit is not an ancestor of HEAD"];
	}

	const routingFailures = validateManifestRouting(manifest);
	if (routingFailures.length > 0) return routingFailures;

	const changedRoutedPaths = deps.changedPaths(sourceCommit)
		.filter((path) => isManifestRoutedPath(path, manifest))
		.sort();
	return changedRoutedPaths.length === 0
		? []
		: [`EDC-routed source files changed since sourceCommit: ${changedRoutedPaths.join(", ")}`];
}

function validateManifestRouting(manifest: unknown): string[] {
	const modules = getArrayProperty(manifest, "modules");
	if (!modules || modules.length === 0) {
		return ["EDC manifest must define at least one routing module"];
	}

	const failures: string[] = [];
	for (const [index, module] of modules.entries()) {
		const match = getObjectProperty(module, "match");
		if (!match) {
			failures.push(`EDC manifest module ${index} match must be an object`);
			continue;
		}

		const exactFiles = getArrayProperty(match, "exactFiles");
		const prefixes = getArrayProperty(match, "prefixes");
		const hasExactFiles = isStringArray(exactFiles);
		const hasPrefixes = isStringArray(prefixes);
		if (!hasExactFiles) {
			failures.push(`EDC manifest module ${index} match.exactFiles must be an array of strings`);
		}
		if (!hasPrefixes) {
			failures.push(`EDC manifest module ${index} match.prefixes must be an array of strings`);
		}
		if (hasExactFiles && hasPrefixes && exactFiles.length + prefixes.length === 0) {
			failures.push(`EDC manifest module ${index} must define at least one exact file or prefix`);
		}
	}
	return failures;
}

function isManifestRoutedPath(path: string, manifest: unknown): boolean {
	return getArrayProperty(manifest, "modules")?.some((module) => {
		const match = getObjectProperty(module, "match");
		return getStringArrayProperty(match, "exactFiles").some((file) => file === path)
			|| getStringArrayProperty(match, "prefixes").some((prefix) => path.startsWith(prefix));
	}) ?? false;
}

function getObjectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const property = (value as Record<string, unknown>)[key];
	return property && typeof property === "object" && !Array.isArray(property)
		? property as Record<string, unknown>
		: undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const property = (value as Record<string, unknown>)[key];
	return typeof property === "string" ? property : undefined;
}

function getArrayProperty(value: unknown, key: string): unknown[] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const property = (value as Record<string, unknown>)[key];
	return Array.isArray(property) ? property : undefined;
}

function isStringArray(value: readonly unknown[] | undefined): value is string[] {
	return value !== undefined && value.every((item): item is string => typeof item === "string");
}

function getStringArrayProperty(value: unknown, key: string): string[] {
	const property = getArrayProperty(value, key);
	return isStringArray(property) ? property : [];
}
