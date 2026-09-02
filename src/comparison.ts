import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { LocalCompactionPreparation } from "./types";

const execFileAsync = promisify(execFile);
const DEFAULT_REPORT_DIRECTORY = join(homedir(), ".pi", "compaction-comparisons");
type TimeoutHandle = ReturnType<typeof setTimeout>;
type ComparisonStatus = "completed" | "failed" | "timed_out" | "cancelled";

type BackendComparisonOutput =
	| { readonly status: "completed"; readonly markdown: string; readonly durationMs: number; readonly outputLength: number }
	| { readonly status: Exclude<ComparisonStatus, "completed">; readonly error: string; readonly durationMs: number; readonly outputLength: number };

export interface CompactionBackendComparison {
	readonly provider: BackendComparisonOutput;
	readonly web: BackendComparisonOutput;
}

export interface RunCompactionBackendComparisonInput {
	readonly preparation: LocalCompactionPreparation;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly now?: () => number;
	readonly setTimeout?: (handler: () => void, timeoutMs: number) => TimeoutHandle;
	readonly clearTimeout?: (timeout: TimeoutHandle) => void;
	readonly runProvider: (preparation: LocalCompactionPreparation, signal: AbortSignal) => Promise<string>;
	readonly runWeb: (preparation: LocalCompactionPreparation, signal: AbortSignal) => Promise<string>;
}

type AbortKind = "timed_out" | "cancelled" | undefined;

function abortError(kind: AbortKind): Error {
	return new Error(kind === "timed_out" ? "comparison timed out" : "comparison cancelled");
}

function awaitAbortable<T>(run: () => Promise<T>, signal: AbortSignal, getAbortKind: () => AbortKind): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(getAbortKind()));
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const settle = (complete: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			complete();
		};
		const onAbort = () => settle(() => reject(abortError(getAbortKind())));
		signal.addEventListener("abort", onAbort, { once: true });
		void Promise.resolve().then(() => {
			if (signal.aborted) throw abortError(getAbortKind());
			return run();
		}).then(
			(value) => settle(() => resolve(value)),
			(error: unknown) => settle(() => reject(error)),
		);
	});
}

interface TimedSettledResult {
	readonly result: PromiseSettledResult<string>;
	readonly endedAt: number;
	readonly abortKind: AbortKind;
}

async function runTimed(
	run: () => Promise<string>,
	signal: AbortSignal,
	getAbortKind: () => AbortKind,
	now: () => number,
): Promise<TimedSettledResult> {
	try {
		return {
			result: { status: "fulfilled", value: await awaitAbortable(run, signal, getAbortKind) },
			endedAt: now(),
			abortKind: getAbortKind(),
		};
	} catch (reason) {
		return { result: { status: "rejected", reason }, endedAt: now(), abortKind: getAbortKind() };
	}
}

function outputFromSettledResult(
	timed: TimedSettledResult,
	startedAt: number,
): BackendComparisonOutput {
	const durationMs = Math.max(0, timed.endedAt - startedAt);
	const { result } = timed;
	if (result.status === "fulfilled") {
		return { status: "completed", markdown: result.value, durationMs, outputLength: result.value.length };
	}
	if (timed.abortKind) {
		return { status: timed.abortKind, error: abortError(timed.abortKind).message, durationMs, outputLength: 0 };
	}
	return {
		status: "failed",
		error: result.reason instanceof Error ? result.reason.message : String(result.reason),
		durationMs,
		outputLength: 0,
	};
}

/** Runs both external backends concurrently without touching async-job state or Pi persistence. */
export async function runCompactionBackendComparison(
	input: RunCompactionBackendComparisonInput,
): Promise<CompactionBackendComparison> {
	const now = input.now ?? Date.now;
	const controller = new AbortController();
	let abortKind: AbortKind;
	const cancel = () => {
		abortKind ??= "cancelled";
		controller.abort();
	};
	input.signal?.addEventListener("abort", cancel, { once: true });
	if (input.signal?.aborted) cancel();
	let timeout: TimeoutHandle | undefined;
	if (input.timeoutMs && input.timeoutMs > 0) {
		const onTimeout = () => {
			abortKind = "timed_out";
			controller.abort();
		};
		timeout = input.setTimeout
			? input.setTimeout(onTimeout, input.timeoutMs)
			: setTimeout(onTimeout, input.timeoutMs);
	}
	const providerStartedAt = now();
	const webStartedAt = now();
	try {
		const [provider, web] = await Promise.all([
			runTimed(() => input.runProvider(input.preparation, controller.signal), controller.signal, () => abortKind, now),
			runTimed(() => input.runWeb(input.preparation, controller.signal), controller.signal, () => abortKind, now),
		]);
		return {
			provider: outputFromSettledResult(provider, providerStartedAt),
			web: outputFromSettledResult(web, webStartedAt),
		};
	} finally {
		if (timeout) {
			if (input.clearTimeout) input.clearTimeout(timeout);
			else clearTimeout(timeout);
		}
		input.signal?.removeEventListener("abort", cancel);
	}
}

export interface ComparisonFileSystem {
	mkdir(path: string, options: { readonly recursive: true; readonly mode: number }): Promise<unknown>;
	writeFile(path: string, content: string, options: { readonly encoding: "utf8"; readonly mode: number }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
}

const nodeFileSystem: ComparisonFileSystem = { mkdir, writeFile, chmod };

export interface ComparisonReport {
	readonly directory: string;
	readonly htmlPath: string;
	readonly providerMarkdownPath: string;
	readonly webMarkdownPath: string;
	readonly metadataPath: string;
}

export interface WriteCompactionComparisonReportInput {
	readonly comparison: CompactionBackendComparison;
	readonly preparation: LocalCompactionPreparation;
	readonly directory?: string;
	readonly createdAt?: Date;
	readonly id?: () => string;
	readonly fs?: ComparisonFileSystem;
}

function reportFileName(createdAt: Date, id: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("comparison report id must be path-safe");
	return `${createdAt.toISOString().replace(/[.:]/g, "-")}-${id}`;
}

function rawMarkdown(output: BackendComparisonOutput, backend: string): string {
	return output.status === "completed" ? output.markdown : `# ${backend} backend ${output.status}\n\n${output.error}\n`;
}

function displayOutput(output: BackendComparisonOutput): string {
	return output.status === "completed" ? output.markdown : `ERROR (${output.status}): ${output.error}`;
}

function metricText(output: BackendComparisonOutput): string {
	return `${output.status} · ${output.durationMs} ms · ${output.outputLength} characters`;
}

export function escapeComparisonHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	}[character] ?? character));
}

function renderComparisonHtml(comparison: CompactionBackendComparison, createdAt: Date): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Pi compaction backend comparison</title>
<style>body{font-family:system-ui;margin:2rem}main{display:grid;grid-template-columns:1fr 1fr;gap:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#111;color:#eee;padding:1rem}h2{margin-top:0}.metrics{font-family:monospace}</style>
</head><body><h1>Pi compaction backend comparison</h1><p>${escapeComparisonHtml(createdAt.toISOString())}</p><main>
<section><h2>Pi provider</h2><p class="metrics">${escapeComparisonHtml(metricText(comparison.provider))}</p><pre>${escapeComparisonHtml(displayOutput(comparison.provider))}</pre></section>
<section><h2>ChatGPT web</h2><p class="metrics">${escapeComparisonHtml(metricText(comparison.web))}</p><pre>${escapeComparisonHtml(displayOutput(comparison.web))}</pre></section>
</main></body></html>`;
}

function stableJson(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return `string:${JSON.stringify(value)}`;
	if (typeof value === "boolean") return `boolean:${value}`;
	if (typeof value === "number") return `number:${String(value)}`;
	if (Array.isArray(value)) return `array:[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `object:{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return `${typeof value}:${String(value)}`;
}

function fullPreparationDigest(preparation: LocalCompactionPreparation): string {
	const exactInput = {
		firstKeptEntryId: preparation.firstKeptEntryId,
		messagesToSummarize: preparation.messagesToSummarize,
		turnPrefixMessages: preparation.turnPrefixMessages,
		isSplitTurn: preparation.isSplitTurn,
		tokensBefore: preparation.tokensBefore,
		previousSummary: preparation.previousSummary,
		settings: preparation.settings,
		fileOps: {
			read: [...preparation.fileOps.read].sort(),
			written: [...preparation.fileOps.written].sort(),
			edited: [...preparation.fileOps.edited].sort(),
		},
	};
	return createHash("sha256").update(stableJson(exactInput)).digest("hex");
}

function sharedSnapshotDescriptor(preparation: LocalCompactionPreparation): Record<string, unknown> {
	return {
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		isSplitTurn: preparation.isSplitTurn,
		messageCount: preparation.messagesToSummarize.length,
		turnPrefixMessageCount: preparation.turnPrefixMessages.length,
		hasPreviousSummary: preparation.previousSummary !== undefined,
		digest: fullPreparationDigest(preparation),
	};
}

function metadataOutput(output: BackendComparisonOutput, rawPath: string): Record<string, unknown> {
	return {
		status: output.status,
		durationMs: output.durationMs,
		outputLength: output.outputLength,
		...(output.status === "completed" ? {} : { error: output.error }),
		rawFilename: basename(rawPath),
	};
}

/** Writes operator-only comparison artifacts with private directory and file modes. */
export async function writeCompactionComparisonReport(
	input: WriteCompactionComparisonReportInput,
): Promise<ComparisonReport> {
	const fs = input.fs ?? nodeFileSystem;
	const directory = input.directory ?? DEFAULT_REPORT_DIRECTORY;
	const createdAt = input.createdAt ?? new Date();
	const stem = reportFileName(createdAt, (input.id ?? randomUUID)());
	const report: ComparisonReport = {
		directory,
		htmlPath: join(directory, `${stem}.html`),
		providerMarkdownPath: join(directory, `${stem}.provider.md`),
		webMarkdownPath: join(directory, `${stem}.web.md`),
		metadataPath: join(directory, `${stem}.json`),
	};
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
	const metadata = {
		createdAt: createdAt.toISOString(),
		sharedSnapshot: sharedSnapshotDescriptor(input.preparation),
		provider: metadataOutput(input.comparison.provider, report.providerMarkdownPath),
		web: metadataOutput(input.comparison.web, report.webMarkdownPath),
	};
	const files: ReadonlyArray<readonly [string, string]> = [
		[report.providerMarkdownPath, rawMarkdown(input.comparison.provider, "Pi provider")],
		[report.webMarkdownPath, rawMarkdown(input.comparison.web, "ChatGPT web")],
		[report.metadataPath, JSON.stringify(metadata, undefined, 2)],
		[report.htmlPath, renderComparisonHtml(input.comparison, createdAt)],
	];
	for (const [path, content] of files) {
		await fs.writeFile(path, content, { encoding: "utf8", mode: 0o600 });
		await fs.chmod(path, 0o600);
	}
	return report;
}

export type OpenFile = (command: string, args: readonly string[]) => Promise<unknown>;
const openFile: OpenFile = (command, args) => execFileAsync(command, [...args]);

/** Opens the report only on macOS and passes the path as an argv element, never through a shell. */
export async function openComparisonReportOnMac(path: string, open: OpenFile = openFile, platform = process.platform): Promise<void> {
	if (platform !== "darwin") return;
	await open("open", [path]);
}
