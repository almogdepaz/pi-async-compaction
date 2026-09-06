import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createDirectBraveLauncher, createPlaywrightChatGptAutomation } from "../src/chatgpt-brave";

const ACCOUNT_HASH = createHash("sha256").update("user-1").digest("hex");

interface FakeContext {
	readonly pages: () => unknown[];
	readonly newPage: () => Promise<unknown>;
	readonly close: () => Promise<void>;
}

interface FakeDirectProcess {
	readonly exited: Promise<{ readonly code: number | null }>;
	terminate(): Promise<void>;
}

interface FakeDirectBrowserLauncher {
	launch(executablePath: string, args: readonly string[]): FakeDirectProcess;
}

interface GenerationFrame {
	readonly responseAttributes?: Readonly<Record<string, string>>;
	readonly descendantAttributes?: readonly Readonly<Record<string, string>>[];
	readonly outsideAttributes?: readonly Readonly<Record<string, string>>[];
	readonly stopCount: number | "error";
	readonly responseInspectionError?: boolean;
}

function loginInput() {
	return {
		url: "https://chatgpt.com/",
		profileDir: "/private/profile",
		braveExecutablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		timeoutMs: 50,
		pollIntervalMs: 1,
		headless: false as const,
	};
}

function completionInput() {
	return {
		...loginInput(),
		url: "https://chatgpt.com/?temporary-chat=true",
		prompt: "summarize",
		expectedAccountHash: ACCOUNT_HASH,
		timeoutMs: 25,
		headless: true as const,
	};
}

function loginPage(sessionAfterPolls = 0, body = "Checking your browser"): unknown {
	let polls = 0;
	return {
		url: () => "https://chatgpt.com/",
		goto: async () => undefined,
		locator: () => ({ innerText: async () => body }),
		evaluate: async () => polls >= sessionAfterPolls ? { user: { id: "user-1" } } : undefined,
		waitForTimeout: async () => { polls++; },
	};
}

function element(attributes: Readonly<Record<string, string>> = {}): {
	readonly getAttribute: (name: string) => string | null;
	readonly querySelectorAll: () => readonly unknown[];
} {
	return {
		getAttribute: (name) => attributes[name] ?? null,
		querySelectorAll: () => [],
	};
}

function completionPage(frames: readonly GenerationFrame[], text = "finished"): {
	readonly page: unknown;
	readonly filled: () => number;
	readonly sent: () => number;
} {
	let fills = 0;
	let sends = 0;
	let frameIndex = 0;
	const currentFrame = (): GenerationFrame => frames[Math.min(frameIndex, frames.length - 1)]
		?? { stopCount: 0 };
	const response = {
		waitFor: async () => undefined,
		innerText: async () => text,
		evaluate: async (callback: (current: unknown) => unknown) => {
			const frame = currentFrame();
			if (frame.responseInspectionError) throw new Error("response inspection failed");
			const current = element(frame.responseAttributes);
			Object.assign(current, { querySelectorAll: () => (frame.descendantAttributes ?? []).map(element) });
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				value: { querySelectorAll: () => (frame.outsideAttributes ?? []).map(element) },
			});
			try {
				return callback(current);
			} finally {
				if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
				else delete (globalThis as { document?: unknown }).document;
			}
		},
		locator: () => ({ count: async () => 1, innerHTML: async () => "<p>finished</p>" }),
	};
	const page = {
		url: () => "https://chatgpt.com/",
		goto: async () => undefined,
		locator: (selector: string) => {
			if (selector === "body") return { innerText: async () => "" };
			if (selector.includes("data-message-author-role")) return { count: async () => 0, nth: () => response };
			if (selector === "#prompt-textarea") return { waitFor: async () => undefined, fill: async () => { fills++; } };
			if (selector === '[data-testid="stop-button"]') {
				return { count: async () => {
					const count = currentFrame().stopCount;
					if (count === "error") throw new Error("stop inspection failed");
					return count;
				} };
			}
			return { click: async () => { sends++; } };
		},
		evaluate: async () => ({ user: { id: "user-1" } }),
		getByRole: (role: string) => role === "alert"
			? { allInnerTexts: async () => [] }
			: { isVisible: async () => false },
		waitForTimeout: async () => { frameIndex++; await Bun.sleep(1); },
	};
	return { page, filled: () => fills, sent: () => sends };
}

function directProcess(
	exited: Promise<{ readonly code: number | null }>,
	onTerminate: () => void | Promise<void> = () => undefined,
): FakeDirectProcess {
	return { exited, terminate: async () => await onTerminate() };
}

function automationFor(
	context: FakeContext,
	launches: Array<{ readonly profileDir: string; readonly options: unknown }>,
	directBrowserLauncher: FakeDirectBrowserLauncher = { launch: () => directProcess(Promise.resolve({ code: 0 })) },
) {
	return createPlaywrightChatGptAutomation({
		launcher: {
			launchPersistentContext: async (profileDir: string, options: unknown) => {
				launches.push({ profileDir, options });
				return context as never;
			},
		},
		directBrowserLauncher,
	} as never);
}

function completionAutomation(frames: readonly GenerationFrame[]) {
	const fixture = completionPage(frames);
	return {
		fixture,
		automation: automationFor({ pages: () => [fixture.page], newPage: async () => fixture.page, close: async () => undefined }, []),
	};
}

describe("playwright Brave automation", () => {
	test("wraps a launcher failure without interpreting browser error prose and preserves its cause", async () => {
		const cause = new Error("launcher failed");
		const automation = createPlaywrightChatGptAutomation({
			launcher: { launchPersistentContext: async () => { throw cause; } },
			directBrowserLauncher: { launch: () => directProcess(Promise.resolve({ code: 0 })) },
		});

		await expect(automation.login(loginInput(), new AbortController().signal)).rejects.toMatchObject({
			message: "Unable to launch the dedicated ChatGPT Brave profile; it may already be in use",
			cause,
		});
	});

	test("runs direct headed Brave with exact argv, then verifies the closed profile headlessly", async () => {
		let newPageCalls = 0;
		let closeCalls = 0;
		const directLaunches: Array<{ readonly executablePath: string; readonly args: readonly string[] }> = [];
		const initialPage = loginPage(0, "");
		const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
		const automation = automationFor({
			pages: () => [initialPage],
			newPage: async () => { newPageCalls++; return loginPage(); },
			close: async () => { closeCalls++; },
		}, launches, {
			launch: (executablePath, args) => {
				directLaunches.push({ executablePath, args });
				return directProcess(Promise.resolve({ code: 0 }));
			},
		});

		expect(await automation.login(loginInput(), new AbortController().signal)).toEqual({ accountHash: ACCOUNT_HASH });
		expect(directLaunches).toEqual([{
			executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			args: ["--user-data-dir=/private/profile", "--no-first-run", "--no-default-browser-check", "--disable-background-mode", "https://chatgpt.com/"],
		}]);
		expect(launches).toEqual([{
			profileDir: "/private/profile",
			options: { executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true },
		}]);
		expect({ newPageCalls, closeCalls }).toEqual({ newPageCalls: 0, closeCalls: 1 });
	});

	test("terminates the owned direct browser after positive confirmation before headless verification", async () => {
		let confirm: ((value: boolean) => void) | undefined;
		let terminations = 0;
		const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
		const page = loginPage(0, "");
		const automation = automationFor(
			{ pages: () => [page], newPage: async () => page, close: async () => undefined },
			launches,
			{ launch: () => directProcess(new Promise(() => undefined), async () => { terminations++; }) },
		);
		const login = automation.login({
			...loginInput(),
			confirm: async () => await new Promise<boolean>((resolve) => { confirm = resolve; }),
		}, new AbortController().signal);
		await Promise.resolve();

		expect(launches).toEqual([]);
		confirm?.(true);
		await expect(login).resolves.toEqual({ accountHash: ACCOUNT_HASH });
		expect({ terminations, launches: launches.length }).toEqual({ terminations: 1, launches: 1 });
	});

	test("cancels confirmation by terminating the owned direct browser without verification", async () => {
		let terminations = 0;
		const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
		const page = loginPage(0, "");
		const automation = automationFor(
			{ pages: () => [page], newPage: async () => page, close: async () => undefined },
			launches,
			{ launch: () => directProcess(new Promise(() => undefined), async () => { terminations++; }) },
		);

		await expect(automation.login({ ...loginInput(), confirm: async () => false }, new AbortController().signal))
			.rejects.toThrow("confirmation cancelled");
		expect({ terminations, launches }).toEqual({ terminations: 1, launches: [] });
	});

	test("dismisses pending confirmation when zero-exit direct Brave wins without changing verification", async () => {
		let confirmationSignal: AbortSignal | undefined;
		let completeConfirmation: ((value: boolean) => void) | undefined;
		const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
		const page = loginPage(0, "");
		const automation = automationFor(
			{ pages: () => [page], newPage: async () => page, close: async () => undefined },
			launches,
			{ launch: () => directProcess(Promise.resolve({ code: 0 })) },
		);

		await expect(automation.login({
			...loginInput(),
			confirm: async (signal) => {
				confirmationSignal = signal;
				return await new Promise<boolean>((resolve) => { completeConfirmation = resolve; });
			},
		}, new AbortController().signal)).resolves.toEqual({ accountHash: ACCOUNT_HASH });
		expect({ aborted: confirmationSignal?.aborted, launches: launches.length }).toEqual({ aborted: true, launches: 1 });
		completeConfirmation?.(false);
		await Promise.resolve();
		expect(launches).toHaveLength(1);
	});

	test("dismisses pending confirmation when direct Brave reports an error without changing failure", async () => {
		let confirmationSignal: AbortSignal | undefined;
		let completeConfirmation: ((value: boolean) => void) | undefined;
		const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
		const page = loginPage(0, "");
		const automation = automationFor(
			{ pages: () => [page], newPage: async () => page, close: async () => undefined },
			launches,
			{ launch: () => directProcess(Promise.reject(new Error("spawn failed"))) },
		);

		await expect(automation.login({
			...loginInput(),
			confirm: async (signal) => {
				confirmationSignal = signal;
				return await new Promise<boolean>((resolve) => { completeConfirmation = resolve; });
			},
		}, new AbortController().signal)).rejects.toThrow("spawn failed");
		expect({ aborted: confirmationSignal?.aborted, launches }).toEqual({ aborted: true, launches: [] });
		completeConfirmation?.(true);
		await Promise.resolve();
		expect(launches).toEqual([]);
	});

	test("does not start Playwright verification until the direct browser exits", async () => {
		let completeDirect: ((value: { readonly code: number | null }) => void) | undefined;
		const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
		const page = loginPage(0, "");
		const automation = automationFor(
			{ pages: () => [page], newPage: async () => page, close: async () => undefined },
			launches,
			{ launch: () => directProcess(new Promise((resolve) => { completeDirect = resolve; })) },
		);
		const login = automation.login(loginInput(), new AbortController().signal);
		await Promise.resolve();

		expect(launches).toEqual([]);
		completeDirect?.({ code: 0 });
		await expect(login).resolves.toEqual({ accountHash: ACCOUNT_HASH });
		expect(launches).toHaveLength(1);
	});

	test("fails before verification when direct Brave exits nonzero or reports a spawn error", async () => {
		for (const createExit of [
			() => Promise.resolve({ code: 1 }),
			() => Promise.reject(new Error("spawn failed")),
		]) {
			const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
			const page = loginPage(0, "");
			const automation = automationFor(
				{ pages: () => [page], newPage: async () => page, close: async () => undefined },
				launches,
				{ launch: () => directProcess(createExit()) },
			);

			await expect(automation.login(loginInput(), new AbortController().signal)).rejects.toThrow();
			expect(launches).toEqual([]);
		}
	});

	test("terminates only its owned direct browser on timeout or abort", async () => {
		for (const abort of [false, true]) {
			let rejectExit: ((error: Error) => void) | undefined;
			let terminations = 0;
			const controller = new AbortController();
			const input = {
				...loginInput(),
				timeoutMs: 5,
				confirm: async () => await new Promise<boolean>(() => undefined),
			};
			const automation = automationFor(
				{ pages: () => [], newPage: async () => loginPage(), close: async () => undefined },
				[],
				{ launch: () => directProcess(new Promise((_, reject) => { rejectExit = reject; }), () => {
					terminations++;
					rejectExit?.(new Error("owned process terminated"));
				}) },
			);
			const login = automation.login(input, controller.signal);
			if (abort) {
				await Promise.resolve();
				controller.abort();
			}

			await expect(login).rejects.toThrow(abort ? "aborted" : "timed out");
			expect(terminations).toBe(1);
		}
	});

	test("settles timeout and abort after bounded owned-process termination even when exit never arrives", async () => {
		for (const abort of [false, true]) {
			let terminations = 0;
			const controller = new AbortController();
			const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
			const automation = automationFor(
				{ pages: () => [], newPage: async () => loginPage(), close: async () => undefined },
				launches,
				{ launch: () => directProcess(new Promise(() => undefined), async () => { terminations++; }) },
			);
			const login = automation.login({
				...loginInput(),
				timeoutMs: 5,
				confirm: async () => await new Promise<boolean>(() => undefined),
			}, controller.signal);
			if (abort) {
				await Promise.resolve();
				controller.abort();
			}
			const outcome = await Promise.race([
				login.then(() => "resolved", (error: Error) => error),
				Bun.sleep(100).then(() => "still pending"),
			]);

			expect(outcome).not.toBe("still pending");
			expect(outcome).toMatchObject({ message: expect.stringContaining(abort ? "aborted" : "timed out") });
			expect({ terminations, launches }).toEqual({ terminations: 1, launches: [] });
		}
	});

	test("preserves timeout classification while surfacing owned-process cleanup failure", async () => {
		const cleanupError = new Error("SIGKILL failed");
		const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
		const automation = automationFor(
			{ pages: () => [], newPage: async () => loginPage(), close: async () => undefined },
			launches,
			{ launch: () => directProcess(new Promise(() => undefined), async () => { throw cleanupError; }) },
		);

		await expect(automation.login({ ...loginInput(), timeoutMs: 5 }, new AbortController().signal)).rejects.toMatchObject({
			message: "ChatGPT login timed out; owned direct Brave cleanup failed",
			cause: cleanupError,
		});
		expect(launches).toEqual([]);
	});

	test("escalates an owned spawned child from SIGTERM to SIGKILL and reports bounded cleanup failure", async () => {
		const listeners = new Map<string, (value: unknown) => void>();
		const signals: string[] = [];
		const launcher = createDirectBraveLauncher({
			spawn: () => ({
				once: (event: string, listener: (value: unknown) => void) => { listeners.set(event, listener); },
				kill: (signal: string) => { signals.push(signal); return true; },
			}),
			terminationGraceMs: 1,
			terminationFinalWaitMs: 1,
		});
		const process = launcher.launch("/private/Brave", ["--user-data-dir=/private/profile"]);

		await expect(process.terminate()).rejects.toThrow("did not exit after SIGTERM and SIGKILL");
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("creates one page only when headless verification finds an empty persistent context", async () => {
		let newPageCalls = 0;
		let closeCalls = 0;
		const launches: Array<{ readonly profileDir: string; readonly options: unknown }> = [];
		const page = loginPage(0, "");
		const automation = automationFor({
			pages: () => [],
			newPage: async () => { newPageCalls++; return page; },
			close: async () => { closeCalls++; },
		}, launches);

		expect(await automation.login(loginInput(), new AbortController().signal)).toEqual({ accountHash: ACCOUNT_HASH });
		expect(launches[0]).toEqual({
			profileDir: "/private/profile",
			options: { executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true },
		});
		expect({ newPageCalls, closeCalls }).toEqual({ newPageCalls: 1, closeCalls: 1 });
	});

	test("fails closed on a headless Cloudflare interstitial before filling or sending", async () => {
		let closeCalls = 0;
		const page = completionPage([{ stopCount: 0 }]);
		(page.page as { locator: (selector: string) => unknown }).locator = (selector: string) => selector === "body"
			? { innerText: async () => "Verify you are human" }
			: { count: async () => 0, nth: () => undefined };
		const automation = automationFor({
			pages: () => [page.page],
			newPage: async () => page.page,
			close: async () => { closeCalls++; },
		}, []);

		await expect(automation.complete(completionInput(), new AbortController().signal)).rejects.toThrow("Cloudflare");
		expect({ filled: page.filled(), sent: page.sent(), closeCalls }).toEqual({ filled: 0, sent: 0, closeCalls: 1 });
	});

	test("accepts stable output after observing active state then structured stop disappearance", async () => {
		const { fixture, automation } = completionAutomation([
			{ responseAttributes: { "data-message-streaming": "true" }, stopCount: 1 },
			{ stopCount: 0 },
			{ stopCount: 0 },
			{ stopCount: 0 },
		]);

		expect(await automation.complete(completionInput(), new AbortController().signal)).toEqual({ markdownHtml: "<p>finished</p>" });
		expect({ filled: fixture.filled(), sent: fixture.sent() }).toEqual({ filled: 1, sent: 1 });
	});

	test("accepts stable output from an explicit current-response finished state", async () => {
		const { automation } = completionAutomation([
			{ responseAttributes: { "data-message-streaming": "finished" }, stopCount: 0 },
		]);

		expect(await automation.complete(completionInput(), new AbortController().signal)).toEqual({ markdownHtml: "<p>finished</p>" });
	});

	test("fails closed without observed activity or after response/stop inspection errors", async () => {
		for (const frames of [
			[{ stopCount: 0 }],
			[{ responseAttributes: { "data-message-streaming": "true" }, stopCount: "error" as const }],
			[{ stopCount: 1, responseInspectionError: true }],
		]) {
			const { automation } = completionAutomation(frames);
			await expect(automation.complete(completionInput(), new AbortController().signal)).rejects.toThrow("incomplete or stalled");
		}
	});

	test("ignores stale streaming markers outside the current response", async () => {
		const { automation } = completionAutomation([
			{ responseAttributes: { "data-is-streaming": "in_progress" }, outsideAttributes: [{ "data-is-streaming": "true" }], stopCount: 1 },
			{ outsideAttributes: [{ "data-is-streaming": "true" }], stopCount: 0 },
			{ outsideAttributes: [{ "data-is-streaming": "true" }], stopCount: 0 },
			{ outsideAttributes: [{ "data-is-streaming": "true" }], stopCount: 0 },
		]);

		expect(await automation.complete(completionInput(), new AbortController().signal)).toEqual({ markdownHtml: "<p>finished</p>" });
	});
});
