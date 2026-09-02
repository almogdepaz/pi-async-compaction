import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { LocalCompactionPreparation } from "./types";
import type { ChatGptRequest } from "./chatgpt-types";

const SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARY_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

function request(kind: ChatGptRequest["kind"], prompt: string): ChatGptRequest {
	return { id: crypto.randomUUID(), kind, prompt };
}

function serialize(messages: LocalCompactionPreparation["messagesToSummarize"]): string {
	return serializeConversation(convertToLlm(messages));
}

export function buildHistorySummaryRequest(preparation: LocalCompactionPreparation): ChatGptRequest {
	let prompt = `<conversation>\n${serialize(preparation.messagesToSummarize)}\n</conversation>\n\n`;
	if (preparation.previousSummary) {
		prompt += `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n`;
	}
	return request("history", `${prompt}${preparation.previousSummary ? UPDATE_SUMMARY_PROMPT : SUMMARY_PROMPT}`);
}

export function buildTurnPrefixSummaryRequest(preparation: LocalCompactionPreparation): ChatGptRequest {
	return request(
		"turn-prefix",
		`<conversation>\n${serialize(preparation.turnPrefixMessages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARY_PROMPT}`,
	);
}
