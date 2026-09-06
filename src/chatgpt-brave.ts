import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import {
	CHATGPT_ORIGIN,
	ChatGptWebAuthenticationError,
	getChatGptAccountId,
} from "./chatgpt-types";
import type {
	ChatGptWebAutomation,
	ChatGptWebCompletionInput,
	ChatGptWebLoginInput,
} from "./chatgpt-types";

export interface PlaywrightBrowserLauncher {
	launchPersistentContext(
		profileDir: string,
		options: { readonly executablePath: string; readonly headless: boolean },
	): Promise<BrowserContext>;
}

export interface DirectBraveExit {
	readonly code: number | null;
}

export interface DirectBraveProcess {
	readonly exited: Promise<DirectBraveExit>;
	terminate(): Promise<void>;
}

export interface DirectBraveLauncher {
	launch(executablePath: string, args: readonly string[]): DirectBraveProcess;
}

export interface DirectBraveChildProcess {
	once(event: "error" | "close", listener: (...args: unknown[]) => void): unknown;
	kill(signal: "SIGTERM" | "SIGKILL"): boolean;
}

export interface DirectBraveLauncherDependencies {
	readonly spawn?: (executablePath: string, args: readonly string[]) => DirectBraveChildProcess;
	readonly terminationGraceMs?: number;
	readonly terminationFinalWaitMs?: number;
}

const DIRECT_TERMINATION_GRACE_MS = 2_000;
const DIRECT_TERMINATION_FINAL_WAIT_MS = 2_000;

export interface PlaywrightChatGptAutomationDependencies {
	readonly launcher?: PlaywrightBrowserLauncher;
	readonly directBrowserLauncher?: DirectBraveLauncher;
}

type CurrentResponseState = "active" | "finished" | "unknown";
type StopButtonState = "active" | "idle" | "error";

interface CurrentResponseObservation {
	readonly state: CurrentResponseState;
	readonly inspected: boolean;
}

function abortError(): Error {
	const error = new Error("ChatGPT request aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

function accountHash(accountId: string): string {
	return createHash("sha256").update(accountId).digest("hex");
}

function isTrustedChatGptPage(page: Page): boolean {
	return new URL(page.url()).origin === CHATGPT_ORIGIN;
}

function assertTrustedChatGptPage(page: Page): void {
	if (!isTrustedChatGptPage(page)) throw new Error("ChatGPT web page left the trusted origin");
}

async function getBodyText(page: Page): Promise<string> {
	return page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
}

async function assertHeadlessUsablePage(page: Page): Promise<void> {
	assertTrustedChatGptPage(page);
	const body = (await getBodyText(page)).toLowerCase();
	if (/verify you are human|checking your browser|cloudflare/.test(body)) {
		throw new Error("ChatGPT blocked the browser with Cloudflare verification");
	}
	if (/rate limit|too many requests|try again later/.test(body)) {
		throw new Error("ChatGPT rate limit reached");
	}
}

async function getAuthenticatedAccountHash(page: Page): Promise<string | undefined> {
	assertTrustedChatGptPage(page);
	const session = await page.evaluate(async () => {
		const response = await fetch("/api/auth/session", { credentials: "same-origin" });
		if (!response.ok) return undefined;
		return response.json();
	}).catch(() => undefined);
	const id = getChatGptAccountId(session);
	return id === undefined ? undefined : accountHash(id);
}

async function assertExpectedAccount(page: Page, expectedAccountHash: string): Promise<void> {
	await assertHeadlessUsablePage(page);
	const actualAccountHash = await getAuthenticatedAccountHash(page);
	if (actualAccountHash === undefined) throw new ChatGptWebAuthenticationError("session_expired");
	if (actualAccountHash !== expectedAccountHash) throw new ChatGptWebAuthenticationError("account_changed");
}

export function getChatGptResponseFailure(text: string): string | undefined {
	const normalized = text.toLowerCase();
	if (/continue generating|continue generation/.test(normalized)) {
		return "ChatGPT response incomplete; generation must be continued";
	}
	if (/something went wrong|error generating|generation failed|network error/.test(normalized)) {
		return "ChatGPT failed to generate a complete response";
	}
	return undefined;
}

async function inspectCurrentResponse(response: ReturnType<Page["locator"]>): Promise<CurrentResponseObservation> {
	try {
		const state = await response.evaluate((assistant) => {
			const values = [assistant, ...assistant.querySelectorAll("[data-is-streaming], [data-message-streaming], [data-status]")]
				.flatMap((element) => [
					element.getAttribute("data-is-streaming"),
					element.getAttribute("data-message-streaming"),
					element.getAttribute("data-status"),
				])
				.filter((value): value is string => value !== null)
				.map((value) => value.toLowerCase());
			if (values.some((value) => value === "true" || value === "in_progress" || value === "in-progress")) return "active";
			if (values.some((value) => value === "false" || value === "finished" || value === "complete" || value === "completed")) return "finished";
			return "unknown";
		});
		return state === "active" || state === "finished" || state === "unknown"
			? { state, inspected: true }
			: { state: "unknown", inspected: false };
	} catch {
		return { state: "unknown", inspected: false };
	}
}

async function inspectStopButton(page: Page): Promise<StopButtonState> {
	try {
		return await page.locator('[data-testid="stop-button"]').count() > 0 ? "active" : "idle";
	} catch {
		return "error";
	}
}

async function waitForCompleteResponse(
	page: Page,
	response: ReturnType<Page["locator"]>,
	input: ChatGptWebCompletionInput,
	signal: AbortSignal,
): Promise<void> {
	await response.waitFor({ state: "visible", timeout: input.timeoutMs }).catch(() => {
		throw new Error("ChatGPT response did not start; the web UI selectors may have changed");
	});

	const deadline = Date.now() + input.timeoutMs;
	let previousText = "";
	let stablePolls = 0;
	let observedActive = false;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		await assertHeadlessUsablePage(page);
		const alertFailure = (await page.getByRole("alert").allInnerTexts())
			.map(getChatGptResponseFailure)
			.find((failure) => failure !== undefined);
		if (alertFailure) throw new Error(alertFailure);
		if (await page.getByRole("button", { name: /continue generating|continue generation/i }).isVisible().catch(() => false)) {
			throw new Error("ChatGPT response incomplete; generation must be continued");
		}
		const responseObservation = await inspectCurrentResponse(response);
		const stopButtonState = await inspectStopButton(page);
		const text = extractCompletedAssistantResponse(await response.innerText());
		if (!responseObservation.inspected || stopButtonState === "error") {
			stablePolls = 0;
		} else if (responseObservation.state === "active" || stopButtonState === "active") {
			observedActive = true;
			stablePolls = 0;
		} else if (text && (responseObservation.state === "finished" || (observedActive && stopButtonState === "idle"))) {
			stablePolls = text === previousText ? stablePolls + 1 : 0;
			if (stablePolls >= 2) return;
		} else {
			stablePolls = 0;
		}
		previousText = text;
		await page.waitForTimeout(input.pollIntervalMs);
	}
	throw new Error("ChatGPT response incomplete or stalled");
}

function extractCompletedAssistantResponse(text: string): string {
	return text.trim();
}

async function extractCompletedAssistantMarkdown(response: ReturnType<Page["locator"]>): Promise<string> {
	const markdownContent = response.locator(".markdown");
	const count = await markdownContent.count();
	if (count === 0) throw new Error("ChatGPT assistant markdown content not found; the web UI selectors may have changed");
	if (count !== 1) throw new Error("ChatGPT assistant markdown content is ambiguous; the web UI selectors may have changed");
	return await markdownContent.innerHTML();
}

async function withDedicatedBraveProfile<TResult>(
	launcher: PlaywrightBrowserLauncher,
	profileDir: string,
	braveExecutablePath: string,
	headless: boolean,
	signal: AbortSignal,
	operation: (page: Page) => Promise<TResult>,
): Promise<TResult> {
	throwIfAborted(signal);
	let context: BrowserContext;
	try {
		context = await launcher.launchPersistentContext(profileDir, { executablePath: braveExecutablePath, headless });
	} catch (error) {
		if (signal.aborted) throw abortError();
		throw new Error("Unable to launch the dedicated ChatGPT Brave profile; it may already be in use", { cause: error });
	}
	let closePromise: Promise<void> | undefined;
	const closeContext = (): Promise<void> => {
		closePromise ??= context.close().catch(() => undefined);
		return closePromise;
	};
	const closeOnAbort = (): void => { void closeContext(); };
	signal.addEventListener("abort", closeOnAbort, { once: true });
	try {
		throwIfAborted(signal);
		const page = context.pages()[0] ?? await context.newPage();
		throwIfAborted(signal);
		return await operation(page);
	} catch (error) {
		if (signal.aborted) throw abortError();
		throw error;
	} finally {
		signal.removeEventListener("abort", closeOnAbort);
		await closeContext();
	}
}

function directBraveArgs(profileDir: string, url: string): string[] {
	return [
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-mode",
		url,
	];
}

function waitForExitWithin(exited: Promise<DirectBraveExit>, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => resolve(false), timeoutMs);
		void exited.then(
			() => { clearTimeout(timeout); resolve(true); },
			(error: unknown) => { clearTimeout(timeout); reject(error); },
		);
	});
}

function signalOwnedChild(child: DirectBraveChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		if (!child.kill(signal)) throw new Error(`owned direct Brave child rejected ${signal}`);
	} catch (error) {
		throw new Error(`Unable to send ${signal} to the owned direct Brave child`, { cause: error });
	}
}

export function createDirectBraveLauncher(
	dependencies: DirectBraveLauncherDependencies = {},
): DirectBraveLauncher {
	const launchChild = dependencies.spawn ?? ((executablePath, args) =>
		spawn(executablePath, args, { shell: false, stdio: "ignore" }));
	const graceMs = dependencies.terminationGraceMs ?? DIRECT_TERMINATION_GRACE_MS;
	const finalWaitMs = dependencies.terminationFinalWaitMs ?? DIRECT_TERMINATION_FINAL_WAIT_MS;
	return {
		launch: (executablePath, args) => {
			const child = launchChild(executablePath, args);
			let settled = false;
			const exited = new Promise<DirectBraveExit>((resolve, reject) => {
				child.once("error", (error) => {
					if (settled) return;
					settled = true;
					reject(error);
				});
				child.once("close", (code) => {
					if (settled) return;
					settled = true;
					resolve({ code: typeof code === "number" ? code : null });
				});
			});
			let termination: Promise<void> | undefined;
			const terminate = (): Promise<void> => {
				termination ??= (async () => {
					signalOwnedChild(child, "SIGTERM");
					if (await waitForExitWithin(exited, graceMs)) return;
					signalOwnedChild(child, "SIGKILL");
					if (await waitForExitWithin(exited, finalWaitMs)) return;
					throw new Error("Owned direct Brave child did not exit after SIGTERM and SIGKILL");
				})();
				return termination;
			};
			return { exited, terminate };
		},
	};
}

type DirectLoginSignal =
	| { readonly kind: "exited"; readonly exit: DirectBraveExit }
	| { readonly kind: "confirmed"; readonly confirmed: boolean };

function waitForDirectLoginSignal(
	process: DirectBraveProcess,
	confirm: ((signal: AbortSignal) => Promise<boolean>) | undefined,
	signal: AbortSignal,
): Promise<DirectLoginSignal> {
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const confirmationController = confirm ? new AbortController() : undefined;
		let settled = false;
		const finish = (operation: () => void, dismissConfirmation: boolean): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (dismissConfirmation) confirmationController?.abort();
			operation();
		};
		const onAbort = (): void => finish(() => reject(abortError()), true);
		signal.addEventListener("abort", onAbort, { once: true });
		void process.exited.then(
			(exit) => finish(() => resolve({ kind: "exited", exit }), true),
			(error: unknown) => finish(() => reject(error), true),
		);
		if (confirm) {
			void confirm(confirmationController?.signal ?? signal).then(
				(confirmed) => finish(() => resolve({ kind: "confirmed", confirmed }), false),
				(error: unknown) => finish(() => reject(error), false),
			);
		}
	});
}

class PlaywrightCoreChatGptAutomation implements ChatGptWebAutomation {
	constructor(
		readonly launcher: PlaywrightBrowserLauncher,
		readonly directBrowserLauncher: DirectBraveLauncher,
	) {}

	async login(input: ChatGptWebLoginInput, signal: AbortSignal): Promise<{ readonly accountHash: string }> {
		const operationController = new AbortController();
		let timedOut = false;
		let directExited = false;
		let directBrowser: DirectBraveProcess | undefined;
		const abortOperation = (): void => operationController.abort();
		const timeout = setTimeout(() => {
			timedOut = true;
			operationController.abort();
		}, input.timeoutMs);
		let termination: Promise<void> | undefined;
		const terminateDirectBrowser = (): void => {
			if (!directExited && directBrowser) termination ??= directBrowser.terminate();
		};
		signal.addEventListener("abort", abortOperation, { once: true });
		operationController.signal.addEventListener("abort", terminateDirectBrowser, { once: true });
		try {
			throwIfAborted(signal);
			directBrowser = this.directBrowserLauncher.launch(
				input.braveExecutablePath,
				directBraveArgs(input.profileDir, input.url),
			);
			const directSignal = await waitForDirectLoginSignal(
				directBrowser,
				input.confirm,
				operationController.signal,
			);
			if (directSignal.kind === "exited") {
				directExited = true;
				if (directSignal.exit.code !== 0) {
					throw new Error(`Dedicated Brave login process exited with code ${String(directSignal.exit.code)}`);
				}
			} else {
				termination ??= directBrowser.terminate();
				await termination;
				directExited = true;
				if (!directSignal.confirmed) throw new Error("ChatGPT login confirmation cancelled");
			}
			if (operationController.signal.aborted) throw abortError();
			const accountHash = await withDedicatedBraveProfile(
				this.launcher,
				input.profileDir,
				input.braveExecutablePath,
				true,
				operationController.signal,
				async (page) => {
					await page.goto(input.url, { waitUntil: "domcontentloaded" });
					await assertHeadlessUsablePage(page);
					const verifiedAccountHash = await getAuthenticatedAccountHash(page);
					if (verifiedAccountHash === undefined) {
						throw new Error("ChatGPT session was not authenticated after direct Brave login");
					}
					return verifiedAccountHash;
				},
			);
			return { accountHash };
		} catch (error) {
			if (operationController.signal.aborted) {
				try {
					await termination;
				} catch (cleanupError) {
					const message = timedOut
						? "ChatGPT login timed out; owned direct Brave cleanup failed"
						: "ChatGPT request aborted; owned direct Brave cleanup failed";
					const failure = new Error(message, { cause: cleanupError });
					if (!timedOut) failure.name = "AbortError";
					throw failure;
				}
				if (timedOut) throw new Error("ChatGPT login timed out");
				throw abortError();
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abortOperation);
			operationController.signal.removeEventListener("abort", terminateDirectBrowser);
		}
	}

	async complete(input: ChatGptWebCompletionInput, signal: AbortSignal): Promise<{ readonly markdownHtml: string }> {
		const markdownHtml = await withDedicatedBraveProfile(
			this.launcher,
			input.profileDir,
			input.braveExecutablePath,
			input.headless,
			signal,
			async (page) => {
				await page.goto(input.url, { waitUntil: "domcontentloaded" });
				throwIfAborted(signal);
				await assertExpectedAccount(page, input.expectedAccountHash);
				const assistantResponses = page.locator('[data-message-author-role="assistant"]');
				const responseCount = await assistantResponses.count();
				const composer = page.locator("#prompt-textarea");
				await composer.waitFor({ state: "visible", timeout: input.timeoutMs }).catch(() => {
					throw new Error("ChatGPT composer not found; the web UI selectors may have changed");
				});
				throwIfAborted(signal);
				await assertHeadlessUsablePage(page);
				await composer.fill(input.prompt);
				throwIfAborted(signal);
				const send = page.locator('[data-testid="send-button"], button[aria-label="Send prompt"]');
				await send.click({ timeout: input.timeoutMs }).catch(() => {
					throw new Error("ChatGPT send button not found; the web UI selectors may have changed");
				});
				const response = assistantResponses.nth(responseCount);
				await waitForCompleteResponse(page, response, input, signal);
				return extractCompletedAssistantMarkdown(response);
			},
		);
		return { markdownHtml };
	}
}

export function createPlaywrightChatGptAutomation(
	dependencies: PlaywrightChatGptAutomationDependencies = {},
): ChatGptWebAutomation {
	return new PlaywrightCoreChatGptAutomation(
		dependencies.launcher ?? chromium,
		dependencies.directBrowserLauncher ?? createDirectBraveLauncher(),
	);
}
