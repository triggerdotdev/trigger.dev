import { sliceWellFormed } from "@internal/dashboard-agent-contracts";
import { locals, logger } from "@trigger.dev/sdk";
import type { ChatAgentCompactionOptions, SummarizeEvent } from "@trigger.dev/sdk/ai";
import { generateText, type ModelMessage, type UIMessage } from "ai";
import {
  dashboardAgentModelKey,
  latestCards,
  resolveDashboardAgentModel,
  sanitizeReplayedToolInputs,
} from "./agent-runtime";
import { stripAgentLinks } from "./linkify-agent-text";
import { dashboardAgentSummaryModel, promptModel, withoutThinking } from "./model-provider";
import { summaryPrompt } from "./prompts";

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
 * How large the model's context may grow before we summarise, as the provider
 * billed the LAST call of the turn: prefix, conversation and tool results together.
 *
 * Budgeting the whole context rather than "input minus a prefix constant" means no
 * figure here has to track the model's tokenizer or the prompt's size (Sonnet 5
 * bills the same prefix ~1.8x what a chars/4 estimate gives). 100k is roughly the
 * old 60k of conversation on top of the measured ~38k prefix: well inside every
 * model's window even when a 10-step turn's run traces and query rows add tens of
 * thousands more, and about where the uncached tail costs more per turn than one
 * summary call does. `DASHBOARD_AGENT_CONTEXT_TOKEN_BUDGET` overrides it per
 * deployment.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 100_000;

export function contextTokenBudget(
  envValue = process.env.DASHBOARD_AGENT_CONTEXT_TOKEN_BUDGET
): number {
  const parsed = Number(envValue?.trim() ?? "");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_TOKEN_BUDGET;
}

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

/**
 * A hard ceiling on the summary, because "under 400 words" is an instruction and not a
 * budget. 400 words is ~530 tokens, so this is roughly double what the summary needs.
 * Thinking is switched off for the call, so none of it goes on hidden reasoning.
 */
const SUMMARY_MAX_OUTPUT_TOKENS = 1_000;

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
 * Two signals, either of which fires against the same budget: the context the
 * provider billed on the last call, and our own chars/4 estimate of the conversation.
 * The estimate leaves out the prefix (it is not in `messages`) and so can only fire
 * later than the provider would; it covers a call with no reported usage and keeps
 * the decision testable without a provider. `inputTokens` must be the last step's,
 * not the turn's sum over steps, which `chat.agent` guarantees for both checks.
 */
export function shouldCompactConversation(
  event: {
    messages: ModelMessage[];
    inputTokens?: number;
    totalTokens?: number;
  },
  budget = contextTokenBudget()
): boolean {
  const reported = typeof event.inputTokens === "number" ? event.inputTokens : event.totalTokens;
  if (typeof reported === "number" && reported > budget) return true;
  return estimateConversationTokens(event.messages) > budget;
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
      // The emitted title carries inline links; the note is prose the model reads back,
      // and a pinned URI would teach it to re-emit a stale one.
      title: stripAgentLinks(card.state.title),
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
  // The summariser is a managed prompt: its text and model are versioned on the
  // platform and overridable from the dashboard, like the system prompt.
  const resolved = await summaryPrompt.resolve({});
  // Dashboard-managed call settings first; the bounded-call safeguards below stay fixed.
  const managed = (resolved.config ?? {}) as Partial<
    Pick<Parameters<typeof generateText>[0], "temperature" | "topP" | "topK" | "stopSequences">
  >;
  const { text } = await generateText({
    ...managed,
    model:
      locals.get(dashboardAgentModelKey) ??
      resolveDashboardAgentModel(
        promptModel(resolved, {
          env: "DASHBOARD_AGENT_SUMMARY_MODEL",
          fallback: dashboardAgentSummaryModel,
        })
      ),
    system: resolved.text,
    prompt: renderTranscriptForSummary(event.messages),
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    providerOptions: withoutThinking(),
    ...resolved.toAISDKTelemetry(),
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
        contextTokenBudget: contextTokenBudget(),
      });
    }
    return compact;
  },
  summarize: summarizeConversation,
  compactModelMessages: ({ summary, uiMessages, modelMessages }) =>
    buildCompactedModelMessages({ summary, uiMessages, modelMessages }),
};
