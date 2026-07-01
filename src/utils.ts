import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, estimateTokens, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_START_RATIO, DEFAULT_TIMEOUT_MS } from "./constants";
import type { ResolvedCompactionSettings } from "./types";

function readNumberSetting(name: string, defaultValue: number): number {
	const value = process.env[name];
	if (!value) return defaultValue;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function getStartRatio(): number {
	return Math.max(0, Math.min(1, readNumberSetting("PI_ASYNC_PREFIX_COMPACTION_START_RATIO", DEFAULT_START_RATIO)));
}

export function getTimeoutMs(): number {
	return Math.max(0, Math.floor(readNumberSetting("PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)));
}

export function isEnabled(): boolean {
	return process.env.PI_ASYNC_PREFIX_COMPACTION !== "0";
}

export function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function settingsKey(settings: ResolvedCompactionSettings): string {
	return JSON.stringify({
		enabled: settings.enabled,
		reserveTokens: settings.reserveTokens,
		keepRecentTokens: settings.keepRecentTokens,
	});
}

export function getCompactionSettings(ctx: ExtensionContext): ResolvedCompactionSettings {
	return SettingsManager.create(ctx.cwd).getCompactionSettings();
}

export function getThinkingLevel(pathEntries: readonly SessionEntry[]): ThinkingLevel {
	const thinkingLevel = buildSessionContext([...pathEntries]).thinkingLevel;
	return isThinkingLevel(thinkingLevel) ? thinkingLevel : "off";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

export function isToolResultEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "toolResult";
}

export function estimateMessagesTokens(messages: readonly Parameters<typeof estimateTokens>[0][]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

export function getStringArrayProperty(value: unknown, key: string): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const property = (value as Record<string, unknown>)[key];
	return Array.isArray(property) ? property.filter((item): item is string => typeof item === "string") : [];
}
