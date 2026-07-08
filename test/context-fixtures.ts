import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import asyncPrefixCompaction from "../src/index";
import { startAsyncJobWithDeps } from "../src/job";
import { validateReadyJob } from "../src/validation";
import { assistantEntry, userEntry } from "./entry-fixtures";

export const settings = {
	enabled: true,
	reserveTokens: 100,
	keepRecentTokens: 1,
};

export function ownAsyncMarker(): Record<string, unknown> {
	return {
		asyncPrefixCompaction: {
			jobId: "async-prefix-compaction-1",
			snapshotLeafId: "a1",
			modelKey: "openai/test-model",
			thinkingLevel: "off",
			settingsKey: JSON.stringify(settings),
			promptVersion: "pi-compact-background-v1",
		},
	};
}

export function testModel(contextWindow = 1_000): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 100,
	};
}

export function validationEvent(customInstructions?: string): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		customInstructions,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		branchEntries: [],
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings,
		},
	};
}

export function validationContext(entries: readonly SessionEntry[], contextWindow = 1_000): ExtensionContext {
	return {
		model: testModel(contextWindow),
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [...entries],
			getLeafId: () => entries[entries.length - 1]?.id ?? null,
		},
	} as ExtensionContext;
}

export function asyncJobContext(entries: readonly SessionEntry[], usageTokens = 850, contextWindow = 1_000): ExtensionContext {
	return {
		cwd: process.cwd(),
		model: testModel(contextWindow),
		getContextUsage: () => ({ tokens: usageTokens, contextWindow }),
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [...entries],
			getLeafId: () => entries[entries.length - 1]?.id ?? null,
		},
	} as ExtensionContext;
}

function manualCommandEntries(): SessionEntry[] {
	return [
		userEntry("u1", null, "old prefix"),
		assistantEntry("a1", "u1", "x".repeat(100_000), 30_000),
		userEntry("u2", "a1", "raw tail starts here"),
	];
}

export function manualCommandContext(entries: readonly SessionEntry[] = manualCommandEntries()): ExtensionContext {
	return {
		...asyncJobContext(entries, 100),
		hasUI: true,
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
		},
		modelRegistry: {
			getApiKeyAndHeaders: () => new Promise<never>(() => {}),
		},
		compact: () => undefined,
	} as unknown as ExtensionContext;
}

export function asyncJobDeps(overrides: Partial<Parameters<typeof startAsyncJobWithDeps>[2]> = {}): Parameters<typeof startAsyncJobWithDeps>[2] {
	return {
		buildAsyncCompactionResult: async (preparation) => ({
			summary: "async summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: { readFiles: [], modifiedFiles: [] },
		}),
		getCompactionSettings: () => settings,
		getStartRatio: () => 0.8,
		getTimeoutMs: () => 0,
		isEnabled: () => true,
		setCliStatus: () => undefined,
		setTimeout,
		clearTimeout,
		triggerCompaction: () => undefined,
		...overrides,
	};
}

export function extensionHarness(deps?: Parameters<typeof asyncPrefixCompaction>[1]): {
	readonly handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	readonly commands: Map<string, { readonly handler: (args: string, ctx: ExtensionContext) => unknown }>;
	readonly notifyMessages: string[];
	readonly statusValues: Array<string | undefined>;
	readonly toolExpansionValues: boolean[];
	readonly ctx: ExtensionContext;
} {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { readonly handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const pi = {
		on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(eventName, handler);
		},
		registerCommand: (name: string, command: { readonly handler: (args: string, ctx: ExtensionContext) => unknown }) => {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	const notifyMessages: string[] = [];
	const statusValues: Array<string | undefined> = [];
	const toolExpansionValues: boolean[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string) => {
				notifyMessages.push(message);
			},
			setStatus: (_key: string, text: string | undefined) => {
				statusValues.push(text);
			},
			setToolsExpanded: (expanded: boolean) => {
				toolExpansionValues.push(expanded);
			},
		},
	} as unknown as ExtensionContext;

	asyncPrefixCompaction(pi, deps);

	return { handlers, commands, notifyMessages, statusValues, toolExpansionValues, ctx };
}

export function readyJob(overrides: Partial<Parameters<typeof validateReadyJob>[0]> = {}): Parameters<typeof validateReadyJob>[0] {
	return {
		jobId: "async-prefix-compaction-1",
		sessionId: "session-1",
		snapshotLeafId: "a2",
		firstKeptEntryId: "u2",
		modelKey: "openai/test-model",
		thinkingLevel: "off",
		settingsKey: JSON.stringify(settings),
		promptVersion: "pi-compact-background-v1",
		result: {
			summary: "summary",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
			details: {
				readFiles: [],
				modifiedFiles: [],
				asyncPrefixCompaction: {
					jobId: "async-prefix-compaction-1",
					snapshotLeafId: "a2",
					modelKey: "openai/test-model",
					thinkingLevel: "off",
					settingsKey: JSON.stringify(settings),
					promptVersion: "pi-compact-background-v1",
				},
			},
		},
		...overrides,
	};
}
