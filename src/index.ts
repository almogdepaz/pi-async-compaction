import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBackendCompactionAdapter, getCompactionBackend, getCompactionMode } from "./backend";
import type { CompactionBackend, CompactionMode } from "./backend";
import { prepareBuiltinPiCompaction } from "./adapter";
import { buildChatGptWebCompactionResult } from "./chatgpt-compaction";
import { loginToChatGptWeb } from "./chatgpt-web";
import {
	openComparisonReportOnMac,
	runCompactionBackendComparison,
	writeCompactionComparisonReport,
} from "./comparison";
import type { CompactionBackendComparison, RunCompactionBackendComparisonInput, WriteCompactionComparisonReportInput } from "./comparison";
import { registerAsyncCompaction } from "./core";
import type { AsyncCompactionCoreDependencies } from "./core";
import { buildAsyncCompactionResult } from "./job";
import { getCompactionSettings, getTimeoutMs } from "./utils";

interface ChatGptLoginState {
	readonly controller: AbortController;
	readonly promise: Promise<void>;
}

export interface AsyncPrefixCompactionDependencies extends Partial<AsyncCompactionCoreDependencies> {
	readonly getInitialBackend?: () => CompactionBackend;
	readonly getInitialMode?: () => CompactionMode;
	readonly getTimeoutMs?: typeof getTimeoutMs;
	readonly runComparison?: (input: RunCompactionBackendComparisonInput) => Promise<CompactionBackendComparison>;
	readonly writeComparisonReport?: (input: WriteCompactionComparisonReportInput) => ReturnType<typeof writeCompactionComparisonReport>;
	readonly openComparisonReport?: (path: string) => Promise<void>;
	readonly getCompactionSettings?: typeof getCompactionSettings;
	readonly loginToChatGptWeb?: typeof loginToChatGptWeb;
}

function reportMessage(ctx: ExtensionContext, message: string, type: "info" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

export default function asyncPrefixCompaction(
	pi: ExtensionAPI,
	injectedDeps: AsyncPrefixCompactionDependencies = {},
): void {
	let backend = (injectedDeps.getInitialBackend ?? getCompactionBackend)();
	let mode = (injectedDeps.getInitialMode ?? getCompactionMode)();
	let comparisonInFlight = false;
	let chatGptLoginState: ChatGptLoginState | undefined;
	const adapter = createBackendCompactionAdapter(() => backend);
	const registration = registerAsyncCompaction(
		pi,
		adapter,
		{
			commandName: "async-compact-now",
			isActive: () => mode === "async",
			inactiveManualMessage: "async compaction not started: normal mode",
		},
		injectedDeps,
	);
	const runComparison = injectedDeps.runComparison ?? runCompactionBackendComparison;
	const writeReport = injectedDeps.writeComparisonReport ?? writeCompactionComparisonReport;
	const openReport = injectedDeps.openComparisonReport ?? openComparisonReportOnMac;
	const resolveCompactionSettings = injectedDeps.getCompactionSettings ?? getCompactionSettings;
	const resolveTimeoutMs = injectedDeps.getTimeoutMs ?? getTimeoutMs;
	const login = injectedDeps.loginToChatGptWeb ?? loginToChatGptWeb;

	pi.registerCommand("chatgpt-web-login", {
		description: "Authorize ChatGPT compaction through the dedicated Brave profile",
		handler: async (_args, ctx) => {
			if (chatGptLoginState) {
				reportMessage(ctx, "ChatGPT web login already in progress", "error");
				return;
			}
			const controller = new AbortController();
			const contextSignal = ctx.signal;
			const abortFromContext = (): void => controller.abort();
			let contextSignalLinked = false;
			if (contextSignal?.aborted) controller.abort();
			else if (contextSignal) {
				contextSignal.addEventListener("abort", abortFromContext, { once: true });
				contextSignalLinked = true;
			}
			reportMessage(ctx, "Sign in to ChatGPT in the dedicated Brave window, then return here to confirm.");
			const loginPromise = Promise.resolve().then(() => login(controller.signal, {
				confirmLogin: ctx.hasUI
					? async (confirmationSignal) => await ctx.ui.confirm(
						"ChatGPT sign-in complete?",
						"Finish signing in to ChatGPT in the dedicated Brave window, return to Pi, then confirm to verify the session.",
						{ signal: confirmationSignal },
					)
					: undefined,
			}));
			chatGptLoginState = { controller, promise: loginPromise };
			try {
				await loginPromise;
				reportMessage(ctx, "ChatGPT web login ready");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				reportMessage(ctx, `ChatGPT web login failed: ${message}`, "error");
			} finally {
				if (contextSignalLinked) contextSignal?.removeEventListener("abort", abortFromContext);
				if (chatGptLoginState?.promise === loginPromise) chatGptLoginState = undefined;
			}
		},
	});

	pi.on("session_shutdown", () => {
		chatGptLoginState?.controller.abort();
	});

	pi.registerCommand("compaction-mode", {
		description: "Select compaction mode: normal or async",
		handler: async (args, ctx) => {
			const explicit = args.trim();
			const selected = explicit || (ctx.hasUI ? await ctx.ui.select("Compaction mode", ["normal", "async"]) : undefined);
			if (selected === undefined) {
				if (!explicit && ctx.hasUI) return;
				reportMessage(ctx, "usage: /compaction-mode normal|async", "error");
				return;
			}
			if (selected !== "normal" && selected !== "async") {
				reportMessage(ctx, "usage: /compaction-mode normal|async", "error");
				return;
			}
			if (selected === mode) {
				reportMessage(ctx, `compaction mode already ${selected}`);
				return;
			}
			registration.invalidate(ctx);
			mode = selected;
			reportMessage(ctx, `compaction mode set to ${selected}`);
		},
	});

	pi.registerCommand("async-compaction-backend", {
		description: "Select async compaction backend: provider or web",
		handler: async (args, ctx) => {
			const explicit = args.trim();
			const selected = explicit || (ctx.hasUI ? await ctx.ui.select("Async compaction backend", ["provider", "web"]) : undefined);
			if (selected === undefined) {
				if (!explicit && ctx.hasUI) return;
				reportMessage(ctx, "usage: /async-compaction-backend provider|web", "error");
				return;
			}
			if (selected !== "provider" && selected !== "web") {
				reportMessage(ctx, "usage: /async-compaction-backend provider|web", "error");
				return;
			}
			if (selected === backend) {
				reportMessage(ctx, `async compaction backend already ${selected}`);
				return;
			}
			registration.invalidate(ctx);
			backend = selected;
			reportMessage(ctx, `async compaction backend set to ${selected}`);
		},
	});

	pi.registerCommand("async-compact-compare", {
		description: "Compare Pi provider and ChatGPT web compaction without applying either",
		handler: async (_args, ctx) => {
			if (comparisonInFlight) {
				reportMessage(ctx, "async compaction comparison already running", "error");
				return;
			}
			comparisonInFlight = true;
			try {
				const settings = resolveCompactionSettings(ctx);
				const prepared = prepareBuiltinPiCompaction(ctx, settings);
				if (!prepared) {
					reportMessage(ctx, "async compaction comparison not started: nothing to compact", "error");
					return;
				}
				const comparison = await runComparison({
					preparation: prepared.preparation,
					signal: ctx.signal,
					timeoutMs: resolveTimeoutMs(),
					runProvider: (preparation, comparisonSignal) =>
						buildAsyncCompactionResult(preparation, prepared.model, ctx, prepared.thinkingLevel, comparisonSignal)
							.then((result) => result.summary),
					runWeb: (preparation, comparisonSignal) =>
						buildChatGptWebCompactionResult(preparation, comparisonSignal).then((result) => result.summary),
				});
				const report = await writeReport({ comparison, preparation: prepared.preparation });
				reportMessage(ctx, `async compaction comparison written to ${report.htmlPath}`);
				try {
					await openReport(report.htmlPath);
				} catch (error) {
					reportMessage(
						ctx,
						`warning: async compaction comparison report could not be opened: ${report.htmlPath} (${error instanceof Error ? error.message : String(error)})`,
						"error",
					);
				}
			} catch (error) {
				reportMessage(
					ctx,
					`async compaction comparison failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				comparisonInFlight = false;
			}
		},
	});
}
