import { describe, expect, test } from "bun:test";
import {
	createBackendCompactionAdapter,
	getCompactionBackend,
	getCompactionMode,
} from "../src/backend";
import {
	escapeComparisonHtml,
	openComparisonReportOnMac,
	runCompactionBackendComparison,
	writeCompactionComparisonReport,
	type ComparisonFileSystem,
} from "../src/comparison";
import { SELECTABLE_ADAPTER_ID, SELECTABLE_ADAPTER_LABEL } from "../src/constants";
import type { LocalCompactionPreparation } from "../src/types";
import { asyncJobContext, compactableEntries, settings } from "./test-fixtures";

function preparation(overrides: Partial<LocalCompactionPreparation> = {}): LocalCompactionPreparation {
	return {
		firstKeptEntryId: "u2",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 123,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings,
		...overrides,
	};
}

function withEnvironment(name: string, value: string | undefined, run: () => void): void {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

function comparisonFixture() {
	return {
		provider: { status: "completed" as const, markdown: "# <provider>", durationMs: 12, outputLength: 12 },
		web: { status: "failed" as const, error: "web & broken", durationMs: 15, outputLength: 0 },
	};
}

describe("compaction backend comparison", () => {
	test("defaults to web/async and accepts only explicit startup selections", () => {
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_BACKEND", undefined, () => expect(getCompactionBackend()).toBe("web"));
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_BACKEND", "provider", () => expect(getCompactionBackend()).toBe("provider"));
		withEnvironment("PI_ASYNC_PREFIX_COMPACTION_BACKEND", "anything-else", () => expect(getCompactionBackend()).toBe("web"));
		withEnvironment("PI_COMPACTION_MODE", undefined, () => expect(getCompactionMode()).toBe("async"));
		withEnvironment("PI_COMPACTION_MODE", "normal", () => expect(getCompactionMode()).toBe("normal"));
		withEnvironment("PI_COMPACTION_MODE", "anything-else", () => expect(getCompactionMode()).toBe("async"));
	});

	test("uses a stable generic identity and snapshots provider routing and prompt correlation", async () => {
		let backend: "provider" | "web" = "provider";
		let providerCalls = 0;
		let webCalls = 0;
		const adapter = createBackendCompactionAdapter(() => backend, {
			buildProviderResult: async (sharedPreparation) => {
				providerCalls++;
				return { summary: `provider:${sharedPreparation.firstKeptEntryId}`, firstKeptEntryId: sharedPreparation.firstKeptEntryId, tokensBefore: sharedPreparation.tokensBefore };
			},
			webTransport: { complete: async () => { webCalls++; return "web summary"; } },
		});
		const ctx = asyncJobContext(compactableEntries());
		const prepared = adapter.prepare({ ctx, settings });
		if (!prepared) throw new Error("expected prepared fixture");
		const snapshot = adapter.createSnapshot({ ctx, prepared, settings, jobId: "job-1" });
		backend = "web";
		const result = await adapter.run({ ctx, prepared, signal: new AbortController().signal });

		expect(adapter.id).toBe(SELECTABLE_ADAPTER_ID);
		expect(adapter.label).toBe(SELECTABLE_ADAPTER_LABEL);
		expect(snapshot.promptVersion).toBe("pi-compact-background-v1");
		expect(result.summary).toBe("provider:u2");
		expect(providerCalls).toBe(1);
		expect(webCalls).toBe(0);
	});

	test("runs both backends concurrently against the exact same preparation and retains a timed-out partial result", async () => {
		const input = preparation();
		const calls: LocalCompactionPreparation[] = [];
		let timeout: (() => void) | undefined;
		let clearedTimeout = false;
		let now = 10;
		const comparison = runCompactionBackendComparison({
			preparation: input,
			timeoutMs: 100,
			now: () => now,
			setTimeout: (handler) => { timeout = handler; return 1 as unknown as ReturnType<typeof setTimeout>; },
			clearTimeout: () => { clearedTimeout = true; },
			runProvider: async (sharedPreparation) => { calls.push(sharedPreparation); return "provider"; },
			runWeb: (sharedPreparation, signal) => {
				calls.push(sharedPreparation);
				return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			},
		});
		for (let index = 0; index < 5; index++) await Promise.resolve();
		// The provider side resolves before the timeout; the web side remains abortable.
		now = 110;
		timeout?.();
		const result = await comparison;

		expect(calls).toEqual([input, input]);
		expect(result.provider).toEqual({ status: "completed", markdown: "provider", durationMs: 0, outputLength: 8 });
		expect(result.web).toEqual({ status: "timed_out", error: "comparison timed out", durationMs: 100, outputLength: 0 });
		expect(clearedTimeout).toBeTrue();
	});

	test("preserves an early backend failure when the other side later times out", async () => {
		let timeout: (() => void) | undefined;
		const comparison = runCompactionBackendComparison({
			preparation: preparation(),
			timeoutMs: 100,
			setTimeout: (handler) => { timeout = handler; return 1 as unknown as ReturnType<typeof setTimeout>; },
			clearTimeout: () => undefined,
			runProvider: async () => { throw new Error("provider rejected first"); },
			runWeb: (_preparation, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
		});
		for (let index = 0; index < 5; index++) await Promise.resolve();
		timeout?.();
		const result = await comparison;

		expect(result.provider.status).toBe("failed");
		expect(result.provider).toMatchObject({ error: "provider rejected first" });
		expect(result.web.status).toBe("timed_out");
	});

	test("does not launch either backend when comparison is immediately cancelled", async () => {
		const controller = new AbortController();
		let providerCalls = 0;
		let webCalls = 0;
		const comparison = runCompactionBackendComparison({
			preparation: preparation(),
			signal: controller.signal,
			runProvider: async () => { providerCalls++; return "provider"; },
			runWeb: async () => { webCalls++; return "web"; },
		});
		controller.abort();
		const result = await comparison;

		expect(result.provider.status).toBe("cancelled");
		expect(result.web.status).toBe("cancelled");
		expect({ providerCalls, webCalls }).toEqual({ providerCalls: 0, webCalls: 0 });
	});

	test("cancels both comparison calls from a supplied Pi context signal and removes listeners", async () => {
		const controller = new AbortController();
		let added = 0;
		let removed = 0;
		const signal = {
			get aborted() { return controller.signal.aborted; },
			addEventListener: (...args: Parameters<AbortSignal["addEventListener"]>) => {
				added++;
				controller.signal.addEventListener(...args);
			},
			removeEventListener: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
				removed++;
				controller.signal.removeEventListener(...args);
			},
		} as unknown as AbortSignal;
		const comparison = runCompactionBackendComparison({
			preparation: preparation(),
			signal,
			runProvider: (_preparation, backendSignal) => new Promise((_, reject) => backendSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
			runWeb: (_preparation, backendSignal) => new Promise((_, reject) => backendSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
		});
		controller.abort();
		const result = await comparison;
		expect(result.provider.status).toBe("cancelled");
		expect(result.web.status).toBe("cancelled");
		expect({ added, removed }).toEqual({ added: 1, removed: 1 });
	});

	test("writes private collision-safe escaped reports with only comparison facts in metadata", async () => {
		const writes = new Map<string, string>();
		const modes: Array<{ readonly path: string; readonly mode: number }> = [];
		const fs: ComparisonFileSystem = {
			mkdir: async (_path, options) => expect(options).toEqual({ recursive: true, mode: 0o700 }),
			writeFile: async (path, content, options) => { writes.set(path, content); expect(options).toEqual({ encoding: "utf8", mode: 0o600 }); },
			chmod: async (path, mode) => { modes.push({ path, mode }); },
		};
		const input = { directory: "/private/compaction-comparisons", createdAt: new Date("2026-01-02T03:04:05.000Z"), comparison: comparisonFixture(), preparation: preparation(), fs };
		const first = await writeCompactionComparisonReport({ ...input, id: () => "one" });
		const second = await writeCompactionComparisonReport({ ...input, id: () => "two" });
		const metadata = writes.get(first.metadataPath);
		const html = writes.get(first.htmlPath);

		expect(first.htmlPath).toBe("/private/compaction-comparisons/2026-01-02T03-04-05-000Z-one.html");
		expect(second.htmlPath).not.toBe(first.htmlPath);
		expect(metadata).toContain('"status": "completed"');
		expect(metadata).toContain('"outputLength": 12');
		expect(metadata).toContain('"sharedSnapshot"');
		expect(metadata).not.toContain("# <provider>");
		expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'");
		expect(html).toContain("12 ms · 12 characters");
		expect(html).toContain("&lt;provider&gt;");
		expect(html).toContain("web &amp; broken");
		expect(modes).toContainEqual({ path: "/private/compaction-comparisons", mode: 0o700 });
		expect(modes).toContainEqual({ path: first.htmlPath, mode: 0o600 });
	});

	test("hashes the full preparation while keeping raw context out of metadata", async () => {
		const writes = new Map<string, string>();
		const fs: ComparisonFileSystem = {
			mkdir: async () => undefined,
			writeFile: async (path, content) => { writes.set(path, content); },
			chmod: async () => undefined,
		};
		const firstPreparation = preparation({
			messagesToSummarize: [{ role: "user", content: "alpha", timestamp: 1 }],
			turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
			previousSummary: "before alpha",
			fileOps: { read: new Set(["a.ts", "b.ts"]), written: new Set(["write.ts"]), edited: new Set(["edit.ts"]) },
		});
		const secondPreparation = preparation({
			messagesToSummarize: [{ role: "user", content: "beta", timestamp: 1 }],
			turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
			previousSummary: "before beta",
			fileOps: { read: new Set(["b.ts", "a.ts"]), written: new Set(["write.ts"]), edited: new Set(["edit.ts"]) },
		});
		const base = { directory: "/private", createdAt: new Date("2026-01-02T03:04:05.000Z"), comparison: comparisonFixture(), fs };
		const first = await writeCompactionComparisonReport({ ...base, preparation: firstPreparation, id: () => "first" });
		const second = await writeCompactionComparisonReport({ ...base, preparation: secondPreparation, id: () => "second" });
		const firstMetadata = writes.get(first.metadataPath);
		const secondMetadata = writes.get(second.metadataPath);
		if (!firstMetadata || !secondMetadata) throw new Error("expected metadata");
		const firstDigest = (JSON.parse(firstMetadata) as { sharedSnapshot: { digest: string } }).sharedSnapshot.digest;
		const secondDigest = (JSON.parse(secondMetadata) as { sharedSnapshot: { digest: string } }).sharedSnapshot.digest;

		expect(firstDigest).not.toBe(secondDigest);
		expect(firstMetadata).not.toContain("alpha");
		expect(secondMetadata).not.toContain("beta");
	});

	test("uses an injectable argv-only macOS opener", async () => {
		const calls: Array<readonly [string, readonly string[]]> = [];
		const open = async (command: string, args: readonly string[]) => { calls.push([command, args]); };
		await openComparisonReportOnMac("/private/report.html", open, "darwin");
		await openComparisonReportOnMac("/private/report.html", open, "linux");
		expect(calls).toEqual([["open", ["/private/report.html"]]]);
	});

	test("escapes all HTML-significant comparison content", () => {
		expect(escapeComparisonHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
	});
});
