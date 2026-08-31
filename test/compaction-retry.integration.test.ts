import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, type RetryPolicy } from "@earendil-works/pi-ai";
import { registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildAsyncCompactionResult } from "../src/job";
import type { LocalCompactionPreparation } from "../src/types";

const registrations: FauxProviderRegistration[] = [];

function registerUniqueFauxProvider(): FauxProviderRegistration {
	const id = randomUUID();
	const registration = registerFauxProvider({
		api: `compaction-retry-api-${id}`,
		provider: `compaction-retry-provider-${id}`,
		models: [{ id: `compaction-retry-model-${id}` }],
	});
	registrations.push(registration);
	return registration;
}

function preparation(): LocalCompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [
			{
				role: "user",
				content: [{ type: "text", text: "old context" }],
				timestamp: Date.now(),
			},
		],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 10,
		fileOps: {
			read: new Set<string>(),
			written: new Set<string>(),
			edited: new Set<string>(),
		},
		settings: SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		}).getCompactionSettings(),
	};
}

function context(): ExtensionContext {
	return {
		cwd: process.cwd(),
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux-key" }),
		},
	} as unknown as ExtensionContext;
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("Pi compaction retry integration", () => {
	test("retries one transient failure through buildAsyncCompactionResult", async () => {
		const registration = registerUniqueFauxProvider();
		registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "503 Service Unavailable",
			}),
			fauxAssistantMessage("summary after retry"),
		]);
		const retry: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 0 };

		const result = await buildAsyncCompactionResult(
			preparation(),
			registration.getModel(),
			context(),
			"off",
			new AbortController().signal,
			undefined,
			() => retry,
		);

		expect(result.summary).toBe("summary after retry");
		expect(registration.state.callCount).toBe(2);
	});

	test("aborting during retry backoff prevents a second provider call", async () => {
		const registration = registerUniqueFauxProvider();
		const controller = new AbortController();
		registration.setResponses([
			() => {
				setTimeout(() => controller.abort(), 0);
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "503 Service Unavailable",
				});
			},
			fauxAssistantMessage("must not run"),
		]);
		const retry: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 10_000 };

		await buildAsyncCompactionResult(
			preparation(),
			registration.getModel(),
			context(),
			"off",
			controller.signal,
			undefined,
			() => retry,
		);

		expect(controller.signal.aborted).toBe(true);
		expect(registration.state.callCount).toBe(1);
	});
});
