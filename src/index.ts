import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBackendCompactionAdapter, getCompactionBackend, getCompactionMode } from "./backend";
import type { CompactionBackend, CompactionMode } from "./backend";
import { prepareBuiltinPiCompaction } from "./adapter";
import { buildChatGptWebCompactionResult } from "./chatgpt-compaction";
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

export interface AsyncPrefixCompactionDependencies extends Partial<AsyncCompactionCoreDependencies> {
	readonly getInitialBackend?: () => CompactionBackend;
	readonly getInitialMode?: () => CompactionMode;
	readonly getTimeoutMs?: typeof getTimeoutMs;
	readonly runComparison?: (input: RunCompactionBackendComparisonInput) => Promise<CompactionBackendComparison>;
	readonly writeComparisonReport?: (input: WriteCompactionComparisonReportInput) => ReturnType<typeof writeCompactionComparisonReport>;
	readonly openComparisonReport?: (path: string) => Promise<void>;
	readonly getCompactionSettings?: typeof getCompactionSettings;
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

	pi.registerCommand("compaction-mode", {
		description: "Select compaction mode: normal or async",
		handler: async (args, ctx) => {
			const selected = args.trim();
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
			const selected = args.trim();
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
