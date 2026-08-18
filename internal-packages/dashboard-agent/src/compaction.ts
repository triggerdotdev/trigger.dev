import { sliceWellFormed } from "@internal/dashboard-agent-contracts";
import { locals, logger } from "@trigger.dev/sdk";
import type { ChatAgentCompactionOptions, SummarizeEvent } from "@trigger.dev/sdk/ai";
import { generateText, type ModelMessage, type UIMessage } from "ai";
import {
  dashboardAgentModelKey,
  latestCards,
  registry,
  sanitizeReplayedToolInputs,
} from "./agent-runtime";

/**
 * Bounded context: how a long conversation is summarised, and what may never be
 * summarised away.
 *
 * A chat re-sends its whole history on every call, so an old chat pays for a tail
 * that grows forever and eventually stops fitting. Above the budget below the older
 * part becomes a summary — but an investigation still in progress is pinned back
 * deterministically, read off the UI transcript rather than trusted to the summary.
 * If the model loses an `investigationId` it opens a SECOND card for the same
 * question, which is the failure this module exists to prevent.
 *
 * Nothing else is pinned. Finished work and watches are the summary's job: a pin has
 * to be exact, and only a live card is both exact and needed verbatim.
 */

/**
 * The static prefix (system prompt + tool schemas) as `prompt-prefix.test.ts`
 * measures it: ~20.9k estimated tokens. Subtracted so the budget below is about the
 * conversation rather than the total.
 */
export const STATIC_PREFIX_TOKENS = 21_000;

/**
 * How much conversation rides on top of that prefix before we summarise.
 *
 * 60k keeps a turn's input near 80k — well inside the 200k window even when a
 * 10-step turn's run traces and query rows add tens of thousands more — and it is
 * about where the uncached tail costs more per turn than one summary call does.
 */
export const CONVERSATION_TOKEN_BUDGET = 60_000;

/** Messages kept verbatim after the summary, so the last exchange reads normally. */
export const COMPACTION_KEPT_TAIL = 8;

/**
 * And a ceiling on those messages together: ~10k tokens. One run trace or query
 * result can be tens of thousands of characters on its own, so a count alone would
 * let a single message carry the whole history back in.
 */
export const COMPACTION_KEPT_TAIL_CHARS = 40_000;

/** Per message, when the transcript is rendered for the summariser. */
const SUMMARY_INPUT_MESSAGE_CHARS = 2_000;

/** The summariser: cheap, bounded, and told exactly what it may not drop. */
const SUMMARY_MODEL = "anthropic:claude-haiku-4-5" as const;

/**
 * A hard ceiling on the summary, because "under 400 words" is an instruction and not a
 * budget. 400 words is ~530 tokens, so this is roughly double what the summary needs.
 */
const SUMMARY_MAX_OUTPUT_TOKENS = 1_000;

export const SUMMARY_INSTRUCTION = `You are compacting a support conversation between a user and an agent that reads a Trigger.dev dashboard, so the agent can keep going with a shorter history.

Write a summary in under 400 words, as notes rather than prose. Keep, in this order:
1. What the user is trying to do, in their own terms, and anything they asked to be remembered.
2. Facts already established, with the run ids, queue names, task identifiers, error fingerprints and numbers they rest on. Never restate a number you cannot see.
3. Any investigation that is open: its investigationId, its title and its current outcome.
4. Any watch the transcript records — what it was set up to watch, and what it said if it reported. Write it as what the transcript recorded, never as what is true now: a watch can expire or be cancelled without saying so here, so never present one as current.
5. What was asked most recently and what is still unanswered.

Drop tool mechanics, retries, and anything already superseded. Do not add advice, and do not invent anything that is not in the transcript. Everything you write is a record of what the transcript said, not a claim about the present.`;

/** A summary that reads as a summary, and never as the user's next question. */
function summaryMessage(summary: string, durableState?: string): ModelMessage {
  return {
    role: "user",
    content: durableState
      ? `[Conversation summary]\n\n${summary}\n\n${durableState}`
      : `[Conversation summary]\n\n${summary}`,
  };
}

/* ------------------------------------------------------------------ *
 * When to compact
 * ------------------------------------------------------------------ */

/** chars / 4, the estimate `prompt-prefix.ts` uses. The provider never sizes a prefix. */
export function estimateConversationTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message)?.length ?? 0;
  }
  return Math.round(chars / 4);
}

/**
 * Two signals, either of which fires: what the provider billed for input minus the
 * prefix, and our own estimate of the conversation. The estimate is what makes this
 * testable and what covers a call the provider reported no usage for.
 */
export function shouldCompactConversation(event: {
  messages: ModelMessage[];
  inputTokens?: number;
  totalTokens?: number;
}): boolean {
  const reported = typeof event.inputTokens === "number" ? event.inputTokens : event.totalTokens;
  const fromProvider = typeof reported === "number" ? reported - STATIC_PREFIX_TOKENS : 0;
  const estimated = estimateConversationTokens(event.messages);
  return Math.max(fromProvider, estimated) > CONVERSATION_TOKEN_BUDGET;
}

/* ------------------------------------------------------------------ *
 * The state a summary may not swallow
 * ------------------------------------------------------------------ */

type PinnedInvestigation = {
  id: string;
  title: string;
  outcome: string;
  revision?: number;
};

export type DurableState = {
  investigations: PinnedInvestigation[];
};

/**
 * The state read off the UI transcript, which compaction never touches. `latestCards`
 * resolves it the way the panel does — highest revision per id wins, whatever order the
 * renders arrived in — so one card stays one card and a stale render can't reopen a
 * settled one.
 *
 * Only an `in_progress` card is state: a concluded or inconclusive one is finished
 * work the summary already covers, and pinning it would grow the note forever and
 * invite the model to keep revising a card that closed long ago.
 *
 * Watches are deliberately not read from here. A watch's lifecycle is server-side —
 * it can fire, expire, or be cancelled with nothing written back into the transcript
 * — so an old confirmation block cannot tell us whether it is still running. There is
 * no watch state on the store either, and nothing about a watch depends on the model
 * remembering it, so the summary is where a watch belongs.
 */
export function collectDurableState(uiMessages: UIMessage[]): DurableState {
  const investigations: PinnedInvestigation[] = [];

  for (const card of latestCards(uiMessages).values()) {
    if (card.state?.outcome !== "in_progress") continue;
    investigations.push({
      id: card.id,
      title: card.state.title,
      outcome: card.state.outcome,
      revision: card.revision,
    });
  }

  return { investigations };
}

/**
 * The state note that rides with every summary. Written as instructions rather than
 * notes: the id is the thing the model has to hand back.
 */
export function describeDurableState(uiMessages: UIMessage[]): string | undefined {
  const state = collectDurableState(uiMessages);
  const lines: string[] = [];

  for (const investigation of state.investigations) {
    const revision =
      investigation.revision === undefined ? "" : ` (revision ${investigation.revision})`;
    lines.push(
      `Investigation ${investigation.id}${revision} — "${investigation.title}", currently ${investigation.outcome}. To revise this card pass investigationId "${investigation.id}" to render_view; never open a second card for it.`
    );
  }

  if (lines.length === 0) return undefined;
  return [
    "[Still live in this conversation — these survived the summary and are exact, so prefer them over anything the summary says about them]",
    ...lines,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Rebuilding the model's history
 * ------------------------------------------------------------------ */

function toolCallIds(message: ModelMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return (message.content as Array<{ type?: string; toolCallId?: string }>)
    .filter((part) => part.type === "tool-call" && typeof part.toolCallId === "string")
    .map((part) => part.toolCallId!);
}

/**
 * The last few messages, within both caps, trimmed to a boundary the provider
 * accepts: no leading tool result without its call, no trailing call without its
 * result.
 */
export function safeTail(
  messages: ModelMessage[],
  count: number,
  maxChars: number = COMPACTION_KEPT_TAIL_CHARS
): ModelMessage[] {
  let start = Math.max(0, messages.length - count);
  let chars = 0;
  for (let i = messages.length - 1; i >= start; i--) {
    chars += JSON.stringify(messages[i])?.length ?? 0;
    if (chars > maxChars) {
      // Keep at least the last message: the model needs what it just answered.
      start = Math.min(i + 1, messages.length - 1);
      break;
    }
  }
  while (start < messages.length && messages[start]!.role === "tool") start++;

  let end = messages.length;
  while (end > start && toolCallIds(messages[end - 1]!).length > 0) end--;

  return messages.slice(start, end);
}

/**
 * What the model gets after a summary: the summary carrying the pinned state, then
 * the last few messages verbatim.
 */
export function buildCompactedModelMessages(args: {
  summary: string;
  uiMessages: UIMessage[];
  modelMessages: ModelMessage[];
  keptTail?: number;
}): ModelMessage[] {
  const tail = sanitizeReplayedToolInputs(
    safeTail(args.modelMessages, args.keptTail ?? COMPACTION_KEPT_TAIL)
  );
  return [summaryMessage(args.summary, describeDurableState(args.uiMessages)), ...tail];
}

/**
 * Pin the state onto a history the SDK rebuilt from a summary itself.
 *
 * The inner (between-steps) compaction path replaces history with the summary alone
 * and never calls `compactModelMessages`, so `prepareMessages` is where the same
 * invariant is applied — see the `"compaction-rebuild"` / `"compaction-result"`
 * reasons. The note goes after the summary, which is always the first message.
 */
export function withDurableState(
  messages: ModelMessage[],
  uiMessages: UIMessage[]
): ModelMessage[] {
  const note = describeDurableState(uiMessages);
  if (!note || messages.length === 0) return messages;
  return [messages[0]!, { role: "user", content: note }, ...messages.slice(1)];
}

/* ------------------------------------------------------------------ *
 * The summariser
 * ------------------------------------------------------------------ */

/** One line per message, each capped, so the summarise call is bounded too. */
export function renderTranscriptForSummary(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      const content =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return `${message.role}: ${sliceWellFormed(content ?? "", SUMMARY_INPUT_MESSAGE_CHARS)}`;
    })
    .join("\n\n");
}

async function summarizeConversation(event: SummarizeEvent): Promise<string> {
  const { text } = await generateText({
    model: locals.get(dashboardAgentModelKey) ?? registry.languageModel(SUMMARY_MODEL),
    system: SUMMARY_INSTRUCTION,
    prompt: renderTranscriptForSummary(event.messages),
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  });
  return text.trim();
}

/**
 * The agent's compaction policy. UI messages are deliberately left alone: the
 * transcript the user reads and the read-model the panel loads keep every message,
 * and only what goes to the model is shortened.
 */
export const dashboardAgentCompaction: ChatAgentCompactionOptions = {
  shouldCompact: (event) => {
    const compact = shouldCompactConversation(event);
    if (compact) {
      logger.info("dashboard-agent compacting the conversation", {
        chatId: event.chatId,
        turn: event.turn,
        source: event.source,
        messageCount: event.messages.length,
        estimatedConversationTokens: estimateConversationTokens(event.messages),
        inputTokens: event.inputTokens ?? null,
      });
    }
    return compact;
  },
  summarize: summarizeConversation,
  compactModelMessages: ({ summary, uiMessages, modelMessages }) =>
    buildCompactedModelMessages({ summary, uiMessages, modelMessages }),
};
