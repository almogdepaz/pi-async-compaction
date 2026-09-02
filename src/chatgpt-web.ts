import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import TurndownService from "turndown";
import type { ChatGptRequest, ChatGptTransport } from "./chatgpt-types";

const CHATGPT_URL = "https://chatgpt.com/";
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const RESPONSE_POLL_MS = 250;

interface ChatGptWebConfig {
	readonly profileDir: string;
	readonly url: string;
	readonly headless: boolean;
	readonly responseTimeoutMs: number;
	readonly loginTimeoutMs: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getConfig(): ChatGptWebConfig {
	return {
		profileDir: process.env.PI_ASYNC_PREFIX_COMPACTION_CHATGPT_PROFILE_DIR
			?? join(homedir(), ".pi", "chatgpt-web-compaction"),
		url: process.env.PI_ASYNC_PREFIX_COMPACTION_CHATGPT_URL ?? CHATGPT_URL,
		headless: process.env.PI_ASYNC_PREFIX_COMPACTION_CHATGPT_HEADLESS === "1",
		responseTimeoutMs: positiveIntegerEnv(
			"PI_ASYNC_PREFIX_COMPACTION_CHATGPT_RESPONSE_TIMEOUT_MS",
			DEFAULT_RESPONSE_TIMEOUT_MS,
		),
		loginTimeoutMs: positiveIntegerEnv(
			"PI_ASYNC_PREFIX_COMPACTION_CHATGPT_LOGIN_TIMEOUT_MS",
			DEFAULT_LOGIN_TIMEOUT_MS,
		),
	};
}

function abortError(): Error {
	const error = new Error("ChatGPT request aborted");
	error.name = "AbortError";
	return error;
}

const profileTails = new Map<string, Promise<void>>();

function waitForProfileTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		void turn.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** Serializes persistent-Chrome ownership per profile while allowing aborted waiters to leave the queue. */
export function serializeChatGptTransportByProfile(profileDir: string, transport: ChatGptTransport): ChatGptTransport {
	return {
		complete: async (request, signal) => {
			const previous = profileTails.get(profileDir) ?? Promise.resolve();
			let release: (() => void) | undefined;
			const completed = new Promise<void>((resolve) => { release = resolve; });
			const turn = previous.then(() => completed);
			profileTails.set(profileDir, turn);
			void turn.then(() => {
				if (profileTails.get(profileDir) === turn) profileTails.delete(profileDir);
			});
			try {
				await waitForProfileTurn(previous, signal);
				if (signal.aborted) throw abortError();
				return await transport.complete(request, signal);
			} finally {
				release?.();
			}
		},
	};
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

/** Validates the minimal account shape returned by ChatGPT's same-origin session endpoint. */
export function hasAuthenticatedChatGptSession(session: unknown): boolean {
	if (!session || typeof session !== "object") return false;
	const user = (session as { readonly user?: unknown }).user;
	if (!user || typeof user !== "object") return false;
	const id = (user as { readonly id?: unknown }).id;
	return typeof id === "string" && id.trim().length > 0;
}

/** Normalizes rendered assistant text used only to detect generation stability. */
export function extractCompletedAssistantResponse(text: string): string {
	return text.trim();
}

/** Converts the selected rendered assistant markdown HTML into the persisted Markdown summary. */
export function convertRenderedAssistantMarkdownToMarkdown(html: string): string {
	return new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" }).turndown(html).trim();
}

function freshChatUrl(url: string): string {
	const freshUrl = new URL(url);
	freshUrl.searchParams.set("temporary-chat", "true");
	return freshUrl.toString();
}

async function getBodyText(page: Page): Promise<string> {
	return page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
}

async function hasAuthenticatedSession(page: Page): Promise<boolean> {
	const session = await page.evaluate(async () => {
		const response = await fetch("/api/auth/session", { credentials: "same-origin" });
		if (!response.ok) return undefined;
		return response.json();
	}).catch(() => undefined);
	return hasAuthenticatedChatGptSession(session);
}

async function assertUsablePage(page: Page): Promise<void> {
	const body = (await getBodyText(page)).toLowerCase();
	if (/verify you are human|checking your browser|cloudflare/.test(body)) {
		throw new Error("ChatGPT blocked the browser with Cloudflare verification");
	}
	if (/rate limit|too many requests|try again later/.test(body)) {
		throw new Error("ChatGPT rate limit reached");
	}
}

async function waitForAuthentication(page: Page, signal: AbortSignal, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal.aborted) throw abortError();
		await assertUsablePage(page);
		if (await hasAuthenticatedSession(page)) return;
		await page.waitForTimeout(RESPONSE_POLL_MS);
	}
	throw new Error("ChatGPT login was not completed before the timeout");
}

async function isGenerating(page: Page): Promise<boolean> {
	return page.getByRole("button", { name: /stop generating|stop streaming/i }).isVisible().catch(() => false);
}

async function generationNeedsContinuation(page: Page): Promise<boolean> {
	return page.getByRole("button", { name: /continue generating|continue generation/i }).isVisible().catch(() => false);
}

async function getAlertFailure(page: Page): Promise<string | undefined> {
	const alerts = await page.getByRole("alert").allInnerTexts();
	return alerts.map(getChatGptResponseFailure).find((failure) => failure !== undefined);
}

async function waitForCompleteResponse(
	page: Page,
	response: ReturnType<Page["locator"]>,
	request: ChatGptRequest,
	timeoutMs: number,
): Promise<void> {
	await response.waitFor({ state: "visible", timeout: timeoutMs }).catch((error: unknown) => {
		throw new Error(`ChatGPT response did not start for request ${request.id}: ${String(error)}`);
	});

	const deadline = Date.now() + timeoutMs;
	let previousText = "";
	let stablePolls = 0;
	while (Date.now() < deadline) {
		const alertFailure = await getAlertFailure(page);
		if (alertFailure) throw new Error(alertFailure);
		const text = extractCompletedAssistantResponse(await response.innerText());
		if (await generationNeedsContinuation(page)) {
			throw new Error("ChatGPT response incomplete; generation must be continued");
		}
		if (text && !await isGenerating(page)) {
			stablePolls = text === previousText ? stablePolls + 1 : 0;
			if (stablePolls >= 2) return;
		} else {
			stablePolls = 0;
		}
		previousText = text;
		await page.waitForTimeout(RESPONSE_POLL_MS);
	}
	throw new Error(`ChatGPT response incomplete or stalled for request ${request.id}`);
}

async function extractCompletedAssistantMarkdown(response: ReturnType<Page["locator"]>): Promise<string> {
	const markdownContent = response.locator(".markdown");
	const count = await markdownContent.count();
	if (count === 0) {
		throw new Error("ChatGPT assistant markdown content not found; the web UI selectors may have changed");
	}
	if (count !== 1) {
		throw new Error("ChatGPT assistant markdown content is ambiguous; the web UI selectors may have changed");
	}
	const markdown = convertRenderedAssistantMarkdownToMarkdown(await markdownContent.innerHTML());
	if (!markdown) {
		throw new Error("ChatGPT assistant markdown content was empty");
	}
	return markdown;
}

class PlaywrightChatGptTransport implements ChatGptTransport {
	readonly config: ChatGptWebConfig;

	constructor(config: ChatGptWebConfig) {
		this.config = config;
	}

	async complete(request: ChatGptRequest, signal: AbortSignal): Promise<string> {
		if (signal.aborted) throw abortError();

		let context: BrowserContext | undefined;
		let page: Page | undefined;
		const closePageOnAbort = (): void => {
			void page?.close().catch(() => undefined);
		};
		signal.addEventListener("abort", closePageOnAbort, { once: true });
		try {
			const { chromium } = await import("playwright");
			context = await chromium.launchPersistentContext(this.config.profileDir, {
				channel: "chrome",
				headless: this.config.headless,
			});
			if (signal.aborted) throw abortError();
			page = await context.newPage();
			await page.goto(freshChatUrl(this.config.url), { waitUntil: "domcontentloaded" });
			if (signal.aborted) throw abortError();
			await assertUsablePage(page);
			const authenticated = await hasAuthenticatedSession(page);
			if (this.config.headless && !authenticated) {
				throw new Error("ChatGPT login required; rerun with headed Chrome to sign in");
			}
			if (!authenticated) await waitForAuthentication(page, signal, this.config.loginTimeoutMs);

			const assistantResponses = page.locator('[data-message-author-role="assistant"]');
			const responseCount = await assistantResponses.count();
			const composer = page.locator("#prompt-textarea");
			await composer.waitFor({ state: "visible", timeout: this.config.responseTimeoutMs }).catch(() => {
				throw new Error("ChatGPT composer not found; the web UI selectors may have changed");
			});
			await composer.fill(request.prompt);
			const send = page.locator('[data-testid="send-button"]');
			await send.click({ timeout: this.config.responseTimeoutMs }).catch(() => {
				throw new Error("ChatGPT send button not found; the web UI selectors may have changed");
			});

			const response = assistantResponses.nth(responseCount);
			await waitForCompleteResponse(page, response, request, this.config.responseTimeoutMs);
			return extractCompletedAssistantMarkdown(response);
		} catch (error) {
			if (signal.aborted) throw abortError();
			throw error;
		} finally {
			signal.removeEventListener("abort", closePageOnAbort);
			await context?.close().catch(() => undefined);
		}
	}
}

/** Creates a lazy browser transport. The persistent profile retains only the user's web login. */
export function createChatGptWebTransport(): ChatGptTransport {
	const config = getConfig();
	return serializeChatGptTransportByProfile(config.profileDir, new PlaywrightChatGptTransport(config));
}
