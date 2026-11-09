import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type RetryPolicy } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildAsyncCompactionResult } from "../src/job";
import type { LocalCompactionPreparation } from "../src/types";

const cleanups: Array<() => void> = [];

async function createProvider() {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
	});
	const provider = fauxProvider({ provider: `compaction-${randomUUID()}` });
	runtime.registerNativeProvider(provider.provider);
	cleanups.push(() => runtime.unregisterProvider(provider.provider.id));
	const ctx = { cwd: process.cwd(), modelRegistry: new ModelRegistry(runtime) } as unknown as ExtensionContext;
	return { provider, ctx };
}

function preparation(): LocalCompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old context" }], timestamp: Date.now() }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 10,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		}).getCompactionSettings(),
	};
}

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("Pi compaction retry integration", () => {
	test("summarizes through the session's native provider without global registration", async () => {
		const { provider, ctx } = await createProvider();
		provider.setResponses([fauxAssistantMessage("native summary")]);
		const result = await buildAsyncCompactionResult(
			preparation(), provider.getModel(), ctx, "off", new AbortController().signal,
			undefined, () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 }),
		);
		expect(result.summary).toBe("native summary");
		expect(result.usage?.totalTokens).toBeGreaterThan(0);
		expect(provider.state.callCount).toBe(1);
	});

	test("retries one transient failure through buildAsyncCompactionResult", async () => {
		const { provider, ctx } = await createProvider();
		provider.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" }),
			fauxAssistantMessage("summary after retry"),
		]);
		const retry: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 0 };
		const result = await buildAsyncCompactionResult(
			preparation(), provider.getModel(), ctx, "off", new AbortController().signal, undefined, () => retry,
		);
		expect(result.summary).toBe("summary after retry");
		expect(provider.state.callCount).toBe(2);
	});

	test("aborting during retry backoff prevents a second provider call", async () => {
		const { provider, ctx } = await createProvider();
		const controller = new AbortController();
		provider.setResponses([
			() => {
				setTimeout(() => controller.abort(), 0);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" });
			},
			fauxAssistantMessage("must not run"),
		]);
		const retry: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 10_000 };
		await buildAsyncCompactionResult(preparation(), provider.getModel(), ctx, "off", controller.signal, undefined, () => retry);
		expect(controller.signal.aborted).toBe(true);
		expect(provider.state.callCount).toBe(1);
	});

	test("does not dispatch when the session provider rejects authentication", async () => {
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const provider = fauxProvider({ provider: `auth-failure-${randomUUID()}` });
		runtime.registerNativeProvider({
			...provider.provider,
			auth: { apiKey: { name: "rejected", resolve: async () => { throw new Error("test credentials rejected"); } } },
		});
		cleanups.push(() => runtime.unregisterProvider(provider.provider.id));
		const ctx = { cwd: process.cwd(), modelRegistry: new ModelRegistry(runtime) } as unknown as ExtensionContext;
		await expect(buildAsyncCompactionResult(
			preparation(), provider.getModel(), ctx, "off", new AbortController().signal,
			undefined, () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 }),
		)).rejects.toThrow("test credentials rejected");
		expect(provider.state.callCount).toBe(0);
	});
});
