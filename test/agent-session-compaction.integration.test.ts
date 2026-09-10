import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { contentText, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createBuiltinPiCompactionAdapter } from "../src/adapter";
import { AUTO_RESUME_PROMPT } from "../src/constants";
import { registerAsyncCompaction, type AsyncCompactionCoreDependencies } from "../src/core";
import type { AsyncCompactionLifecycleEvent } from "../src/diagnostics";
import { applyReadyCompaction, startAsyncJobWithDeps } from "../src/job";

const astraExtensionPath = process.env.ASTRA_EXTENSION_PATH;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => resolvePromise?.(),
	};
}

test(
	"applies ready work through a real AgentSession and resumes exactly once",
	async () => {
		const id = randomUUID();
		const cwd = process.cwd();
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
		const sessionManager = SessionManager.inMemory(cwd);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const provider = fauxProvider({
			api: `agent-session-api-${id}`,
			provider: `agent-session-provider-${id}`,
			models: [{ id: `agent-session-model-${id}`, contextWindow: 10_000, maxTokens: 1_000 }],
		});
		modelRuntime.registerNativeProvider(provider.provider);

		const backgroundStarted = deferred();
		const releaseBackground = deferred();
		const activeCallStarted = deferred();
		const activeCallAborted = deferred();
		const resumedCallStarted = deferred();
		const lifecycleEvents: AsyncCompactionLifecycleEvent[] = [];
		let backgroundCalls = 0;
		let automaticStarts = 0;
		let resumedProviderCalls = 0;
		let successfulCompactions = 0;

		provider.setResponses([
			fauxAssistantMessage("initial response"),
			async (_context, options) => {
				activeCallStarted.resolve();
				const signal = options?.signal;
				if (!signal) throw new Error("active model call did not receive an abort signal");
				if (!signal.aborted) {
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				}
				activeCallAborted.resolve();
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
			() => {
				resumedProviderCalls++;
				resumedCallStarted.resolve();
				return fauxAssistantMessage("resumed response");
			},
		]);

		const buildResult: Parameters<typeof createBuiltinPiCompactionAdapter>[0] = async (preparation, _model, _ctx, _thinkingLevel, signal) => {
			backgroundCalls++;
			backgroundStarted.resolve();
			await releaseBackground.promise;
			signal.throwIfAborted();
			return {
				summary: "background summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: { readFiles: [], modifiedFiles: [] },
			};
		};
		const adapter = createBuiltinPiCompactionAdapter(buildResult);
		const jobDependencies: Parameters<typeof startAsyncJobWithDeps>[2] = {
			adapter,
			buildAsyncCompactionResult: buildResult,
			getCompactionSettings: () => settingsManager.getCompactionSettings(),
			getStartRatio: () => 0,
			getTimeoutMs: () => 0,
			isEnabled: () => true,
			setCliStatus: () => undefined,
			setTimeout,
			clearTimeout,
			triggerCompaction: (ctx, onError) => ctx.compact({ onError }),
		};
		const injectedCoreDependencies: Partial<AsyncCompactionCoreDependencies> = {
			startAsyncJob: (ctx, state, options) => {
				automaticStarts++;
				if (automaticStarts > 1) return "below_threshold";
				return startAsyncJobWithDeps(ctx, state, jobDependencies, {
					...options,
					force: true,
				});
			},
			applyReadyCompaction: (ctx, state) => applyReadyCompaction(ctx, state, jobDependencies),
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: `/virtual/pi-agent-${id}`,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: astraExtensionPath ? [astraExtensionPath] : [],
			systemPrompt: "integration test",
			appendSystemPrompt: [],
			extensionFactories: [
				{
					name: `async-compaction-${id}`,
					factory: (pi) => {
						registerAsyncCompaction(
							pi,
							adapter,
							{ commandName: false, onLifecycleEvent: (event) => lifecycleEvents.push(event) },
							injectedCoreDependencies,
						);
					},
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: `/virtual/pi-agent-${id}`,
			model: provider.getModel(),
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
			noTools: "all",
		});
		session.subscribe((event) => {
			if (event.type === "compaction_end" && !event.aborted && event.result) successfulCompactions++;
		});

		try {
			await session.prompt("initial request");
			await backgroundStarted.promise;

			const interruptedPrompt = session.prompt("active request").catch(() => undefined);
			await activeCallStarted.promise;
			releaseBackground.resolve();

			await activeCallAborted.promise;
			await resumedCallStarted.promise;
			await session.waitForIdle();
			await interruptedPrompt;

			const entries = sessionManager.getEntries();
			const compactions = entries.filter((entry) => entry.type === "compaction");
			const resumedUserMessages = session.messages.filter(
				(message) => message.role === "user" && contentText(message.content) === AUTO_RESUME_PROMPT,
			);
			const resumedAssistantMessages = session.messages.filter(
				(message) => message.role === "assistant" && contentText(message.content) === "resumed response",
			);
			const lifecycleNames: string[] = lifecycleEvents.map((event) => event.event);

			expect(provider.state.callCount).toBe(3);
			expect(backgroundCalls).toBe(1);
			expect(compactions).toHaveLength(1);
			expect(compactions[0]?.fromHook).toBe(true);
			expect(successfulCompactions).toBe(1);
			expect(resumedUserMessages).toHaveLength(1);
			expect(resumedProviderCalls).toBe(1);
			expect(resumedAssistantMessages).toHaveLength(1);
			expect(lifecycleNames.filter((event) => event === "handed_off")).toHaveLength(1);
			expect(lifecycleNames.filter((event) => event === "failed")).toHaveLength(0);
		} finally {
			session.dispose();
			modelRuntime.unregisterProvider(provider.provider.id);
		}
	},
	10_000,
);
