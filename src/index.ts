import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChatGptWebCompactionAdapter } from "./adapter";
import { registerAsyncCompaction } from "./core";
import type { AsyncCompactionCoreDependencies } from "./core";

export default function asyncPrefixCompaction(
	pi: ExtensionAPI,
	injectedDeps: Partial<AsyncCompactionCoreDependencies> = {},
): void {
	registerAsyncCompaction(
		pi,
		createChatGptWebCompactionAdapter(),
		{ commandName: "async-compact-now" },
		injectedDeps,
	);
}
