import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { contentText, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBuiltinPiCompactionAdapter } from "../src/adapter";
import { registerAsyncCompaction, type AsyncCompactionCoreDependencies } from "../src/core";
import type { AsyncCompactionLifecycleEvent } from "../src/diagnostics";
import { applyReadyCompaction, proposeBoundaryCompaction, startAsyncJobWithDeps } from "../src/job";

// Earlier releases resumed an aborted turn by sending this user message; it must never be sent now.
const LEGACY_RESUME_PROMPT = "continue";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

type Scenario = "tool-turn" | "final-turn" | "final-turn-steered" | "tool-turn-cancelled";

interface BoundaryApplyOptions {
	/** Registers another extension's turn_end handler before async compaction; it proposes this draft at the tool boundary. */
	readonly earlierBoundaryDraft?: "context_edit" | "compaction";
	/**
	 * Registers another extension's turn_end handler that continues the run after the active final response.
	 * Stock Pi accepts `continue` only when the context does not end with an assistant message, so it adds a custom message.
	 */
	readonly earlierContinue?: boolean;
}

async function runBoundaryApply(scenario: Scenario, options: BoundaryApplyOptions = {}) {
	const id = randomUUID();
	const cwd = process.cwd();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const provider = fauxProvider({
		api: `boundary-apply-api-${id}`,
		provider: `boundary-apply-provider-${id}`,
		models: [{ id: `boundary-apply-model-${id}`, contextWindow: 10_000, maxTokens: 1_000 }],
	});
	modelRuntime.registerNativeProvider(provider.provider);

	const backgroundStarted = deferred();
	const releaseBackground = deferred();
	const jobReady = deferred();
	const activeWorkStarted = deferred();
	const releaseActiveWork = deferred();
	const lifecycleEvents: AsyncCompactionLifecycleEvent[] = [];
	let automaticStarts = 0;
	let activeWorkAborted = false;

	// Holds the active model call or tool until the test releases it; records whether Pi aborted it.
	const holdActiveWork = async (signal: AbortSignal | undefined) => {
		activeWorkStarted.resolve();
		if (!signal) throw new Error("active work did not receive an abort signal");
		await Promise.race([
			releaseActiveWork.promise,
			new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
		]);
		if (signal.aborted) activeWorkAborted = true;
		return signal.aborted;
	};

	let finalRequestTexts: string[] | undefined;
	const captureFinalRequest: Parameters<typeof provider.setResponses>[0][number] = (context) => {
		finalRequestTexts = context.messages.map((message) =>
			typeof message.content === "string" ? message.content : contentText(message.content));
		return fauxAssistantMessage("final response");
	};
	const usesTool = scenario === "tool-turn" || scenario === "tool-turn-cancelled";
	provider.setResponses(usesTool
		? [
			fauxAssistantMessage("initial response"),
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			captureFinalRequest,
		]
		: [
			fauxAssistantMessage("initial response"),
			async (_context, callOptions) => {
				const aborted = await holdActiveWork(callOptions?.signal);
				return aborted ? fauxAssistantMessage("", { stopReason: "aborted" }) : fauxAssistantMessage("active response");
			},
			captureFinalRequest,
		]);

	const holdTool = defineTool({
		name: "hold",
		label: "Hold",
		description: "Waits until the test releases it",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const aborted = await holdActiveWork(signal);
			return { content: [{ type: "text", text: aborted ? "aborted" : "held" }], details: {} };
		},
	});

	const buildResult: Parameters<typeof createBuiltinPiCompactionAdapter>[0] = async (preparation, _model, _ctx, _thinkingLevel, signal) => {
		backgroundStarted.resolve();
		await releaseBackground.promise;
		signal.throwIfAborted();
		return {
			// The summary restates the summarized user text, as a real summary would.
			summary: "background summary: initial request",
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
		startAsyncJob: (ctx, state, startOptions) => {
			automaticStarts++;
			if (automaticStarts > 1) return "below_threshold";
			return startAsyncJobWithDeps(ctx, state, jobDependencies, startOptions);
		},
		applyReadyCompaction: (ctx, state) => applyReadyCompaction(ctx, state, jobDependencies),
		proposeBoundaryCompaction: (ctx, state, boundary) => proposeBoundaryCompaction(ctx, state, boundary, jobDependencies),
	};
	const registerEarlierBoundaryHandler = (pi: ExtensionAPI) => {
		if (options.earlierContinue) {
			pi.on("turn_end", (event) =>
				event.message.role === "assistant" && contentText(event.message.content) === "active response"
					? {
						entries: [
							...event.entries,
							{ type: "custom_message", customType: "boundary-continue-test", content: "continue request", display: false },
						],
						continue: true,
					}
					: undefined);
		}
		const kind = options.earlierBoundaryDraft;
		if (!kind) return;
		pi.on("turn_end", (event, ctx) => {
			if (event.toolResults.length === 0) return undefined;
			const users = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
			if (kind === "context_edit") {
				const target = users[0];
				if (!target) throw new Error("missing first user entry");
				return { entries: [...event.entries, { type: "context_edit", targetId: target.id, replacement: null }] };
			}
			const firstKept = users.at(-1);
			if (!firstKept) throw new Error("missing latest user entry");
			return { entries: [...event.entries, { type: "compaction", summary: "competing summary", firstKeptEntryId: firstKept.id }] };
		});
	};
	const agentDir = `/virtual/pi-agent-${id}`;
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "integration test", appendSystemPrompt: [],
		extensionFactories: [{
			name: `boundary-apply-${id}`,
			factory: (pi) => {
				pi.registerTool(holdTool);
				registerEarlierBoundaryHandler(pi);
				registerAsyncCompaction(pi, adapter, {
					commandName: false,
					onLifecycleEvent: (event) => {
						lifecycleEvents.push(event);
						if (event.event === "ready") jobReady.resolve();
					},
				}, injectedCoreDependencies);
			},
		}],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd, agentDir, model: provider.getModel(), thinkingLevel: "off",
		modelRuntime, resourceLoader, sessionManager, settingsManager, noTools: "builtin",
	});

	// Pi emits compaction_end only for session compactions (ctx.compact); a committed turn_end draft emits none.
	const sessionCompactionEnds: string[] = [];
	// Each agent_end is one reported run completion; an abort-and-resume produces two for one request.
	let agentEnds = 0;
	session.subscribe((event) => {
		if (event.type === "compaction_end") sessionCompactionEnds.push(event.reason);
		if (event.type === "agent_end") agentEnds++;
	});

	try {
		await session.prompt("initial request");
		await backgroundStarted.promise;
		const agentEndsBeforeActive = agentEnds;

		const activePrompt = session.prompt("active request").catch(() => undefined);
		await activeWorkStarted.promise;
		releaseBackground.resolve();
		await jobReady.promise;
		// Let any work scheduled by the ready transition run while the active work is still held.
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (scenario === "tool-turn-cancelled") await session.abort();
		else {
			if (scenario === "final-turn-steered") await session.steer("steer request");
			releaseActiveWork.resolve();
		}
		await activePrompt;
		await session.waitForIdle();
		// Let deferred extension work, if any, start and settle before inspecting the result.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await session.waitForIdle();

		const branch = sessionManager.getBranch();
		return {
			activeAgentEnds: agentEnds - agentEndsBeforeActive,
			activeWorkAborted,
			compactions: sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
			branchTypes: branch.map((entry) => entry.type === "message" ? `${entry.type}:${entry.message.role}` : entry.type),
			autoResumePrompts: session.messages.filter(
				(message) => message.role === "user" && contentText(message.content) === LEGACY_RESUME_PROMPT,
			).length,
			finalResponses: session.messages.filter(
				(message) => message.role === "assistant" && contentText(message.content) === "final response",
			).length,
			activeResponses: session.messages.filter(
				(message) => message.role === "assistant" && contentText(message.content) === "active response",
			).length,
			lifecycle: lifecycleEvents.map((event) => event.event),
			invalidationReasons: lifecycleEvents.flatMap((event) => event.event === "invalidated" ? [event.reason] : []),
			providerCalls: provider.state.callCount,
			finalRequestTexts,
			sessionCompactionEnds,
		};
	} finally {
		session.dispose();
		modelRuntime.unregisterProvider(provider.provider.id);
	}
}

test("ready work during a tool turn compacts at the tool boundary without aborting the tool or resuming", async () => {
	const result = await runBoundaryApply("tool-turn");

	expect(result.activeWorkAborted).toBe(false);
	expect(result.activeAgentEnds).toBe(1);
	expect(result.compactions).toHaveLength(1);
	expect(result.compactions[0]?.fromHook).toBe(true);
	expect(result.sessionCompactionEnds).toEqual([]);
	expect(result.autoResumePrompts).toBe(0);
	expect(result.finalResponses).toBe(1);
	expect(result.providerCalls).toBe(3);
	// The request after the boundary uses the compacted projection, not the pre-compaction prefix.
	expect(result.finalRequestTexts?.some((text) => text.includes("background summary"))).toBe(true);
	expect(result.finalRequestTexts).not.toContain("initial request");
	// The kept tail keeps the assistant tool call before its result.
	const compactionIndex = result.branchTypes.indexOf("compaction");
	expect(result.branchTypes.slice(compactionIndex - 2, compactionIndex)).toEqual(["message:assistant", "message:toolResult"]);
	expect(result.lifecycle.filter((event) => event === "handed_off")).toHaveLength(1);
	expect(result.lifecycle).not.toContain("failed");
}, 10_000);

test("ready work during a final model response applies after settlement without aborting the response", async () => {
	const result = await runBoundaryApply("final-turn");

	expect(result.activeWorkAborted).toBe(false);
	expect(result.activeAgentEnds).toBe(1);
	expect(result.activeResponses).toBe(1);
	expect(result.finalResponses).toBe(0);
	expect(result.autoResumePrompts).toBe(0);
	expect(result.providerCalls).toBe(2);
	expect(result.compactions).toHaveLength(1);
	expect(result.sessionCompactionEnds).toEqual(["manual"]);
	expect(result.lifecycle.filter((event) => event === "handed_off")).toHaveLength(1);
	expect(result.lifecycle).not.toContain("failed");
}, 10_000);

test("ready work before a queued steering message compacts at the boundary and delivers the message once after the summary", async () => {
	const result = await runBoundaryApply("final-turn-steered");

	expect(result.activeWorkAborted).toBe(false);
	expect(result.activeAgentEnds).toBe(1);
	expect(result.activeResponses).toBe(1);
	expect(result.finalResponses).toBe(1);
	expect(result.providerCalls).toBe(3);
	expect(result.autoResumePrompts).toBe(0);
	expect(result.compactions).toHaveLength(1);
	expect(result.compactions[0]?.fromHook).toBe(true);
	expect(result.sessionCompactionEnds).toEqual([]);
	// Pi commits the boundary draft before it sends the queued message, so the summary precedes it.
	const summaryIndex = result.finalRequestTexts?.findIndex((text) => text.includes("background summary")) ?? -1;
	const steerIndex = result.finalRequestTexts?.indexOf("steer request") ?? -1;
	expect(summaryIndex).toBeGreaterThanOrEqual(0);
	expect(steerIndex).toBeGreaterThan(summaryIndex);
	expect(result.finalRequestTexts?.filter((text) => text === "steer request")).toHaveLength(1);
	expect(result.finalRequestTexts).not.toContain("initial request");
	expect(result.lifecycle.filter((event) => event === "handed_off")).toHaveLength(1);
	expect(result.lifecycle).not.toContain("failed");
}, 10_000);

test("cancelling the active run does not append a boundary compaction or continue the run", async () => {
	const result = await runBoundaryApply("tool-turn-cancelled");

	expect(result.providerCalls).toBe(2);
	expect(result.finalResponses).toBe(0);
	expect(result.autoResumePrompts).toBe(0);
	expect(result.finalRequestTexts).toBeUndefined();
	expect(result.activeAgentEnds).toBe(1);
	// The only compaction is the settled idle-path session compaction, not a boundary draft in the aborted run.
	expect(result.compactions).toHaveLength(1);
	expect(result.sessionCompactionEnds).toEqual(["manual"]);
	expect(result.lifecycle).not.toContain("failed");
}, 10_000);

test("a context edit proposed earlier at the same boundary invalidates the ready summary", async () => {
	const result = await runBoundaryApply("tool-turn", { earlierBoundaryDraft: "context_edit" });

	// The summary covers the omitted user entry, so applying it would reintroduce that content.
	expect(result.finalRequestTexts?.join("\n")).not.toContain("initial request");
	expect(result.compactions).toEqual([]);
	expect(result.invalidationReasons).toEqual(["context_edited"]);
	expect(result.lifecycle).not.toContain("handed_off");
	expect(result.activeWorkAborted).toBe(false);
	expect(result.activeAgentEnds).toBe(1);
	expect(result.finalResponses).toBe(1);
	expect(result.autoResumePrompts).toBe(0);
}, 10_000);

test("a compaction proposed earlier at the same boundary supersedes the ready summary", async () => {
	const result = await runBoundaryApply("tool-turn", { earlierBoundaryDraft: "compaction" });

	expect(result.compactions).toHaveLength(1);
	expect(result.compactions[0]).toMatchObject({ summary: "competing summary" });
	expect(result.invalidationReasons).toEqual(["superseded"]);
	expect(result.lifecycle).not.toContain("handed_off");
	expect(result.activeWorkAborted).toBe(false);
	expect(result.activeAgentEnds).toBe(1);
	expect(result.finalResponses).toBe(1);
	expect(result.autoResumePrompts).toBe(0);
}, 10_000);

test("ready work at a final response that another extension continues compacts at that boundary", async () => {
	const result = await runBoundaryApply("final-turn", { earlierContinue: true });

	expect(result.activeWorkAborted).toBe(false);
	expect(result.activeAgentEnds).toBe(1);
	expect(result.activeResponses).toBe(1);
	expect(result.finalResponses).toBe(1);
	expect(result.providerCalls).toBe(3);
	expect(result.autoResumePrompts).toBe(0);
	expect(result.compactions).toHaveLength(1);
	expect(result.compactions[0]?.fromHook).toBe(true);
	expect(result.sessionCompactionEnds).toEqual([]);
	const summaryIndex = result.finalRequestTexts?.findIndex((text) => text.includes("background summary")) ?? -1;
	expect(summaryIndex).toBeGreaterThanOrEqual(0);
	expect(result.finalRequestTexts?.indexOf("continue request")).toBeGreaterThan(summaryIndex);
	expect(result.finalRequestTexts).not.toContain("initial request");
	expect(result.lifecycle.filter((event) => event === "handed_off")).toHaveLength(1);
	expect(result.lifecycle).not.toContain("failed");
}, 10_000);
