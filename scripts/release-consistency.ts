export interface ReleaseConsistencyInput {
	readonly version: string;
	readonly tagsAtHead: readonly string[];
	readonly changelog: string;
	readonly readme: string;
}

export function checkReleaseConsistency(input: ReleaseConsistencyInput): string[] {
	const failures: string[] = [];
	if (!/^\d+\.\d+\.\d+$/.test(input.version)) {
		failures.push("package.json version must be an exact semantic version");
		return failures;
	}

	const releaseTag = `v${input.version}`;
	const datedHeading = new RegExp(`^## ${escapeRegExp(input.version)} — \\d{4}-\\d{2}-\\d{2}$`, "m");
	const hasDatedHeading = datedHeading.test(input.changelog);
	const taggedInstall = `pi install git:github.com/almogdepaz/pi-async-compaction@${releaseTag}`;
	const hasTaggedInstall = input.readme.includes(taggedInstall);
	if (input.tagsAtHead.includes(releaseTag) || hasDatedHeading || hasTaggedInstall) {
		if (!hasDatedHeading) {
			failures.push(`CHANGELOG.md must include a dated ${input.version} heading for ${releaseTag}`);
		}
		if (!hasTaggedInstall) {
			failures.push(`README.md must install the tagged release from @${releaseTag}`);
		}
		return failures;
	}

	if (!input.changelog.includes(`## ${input.version} — unreleased`)) {
		failures.push(`CHANGELOG.md must include an unreleased ${input.version} section`);
	}
	if (!input.readme.includes("pi install git:github.com/almogdepaz/pi-async-compaction@main")) {
		failures.push("README.md must install the unreleased Git source from main");
	}
	return failures;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
