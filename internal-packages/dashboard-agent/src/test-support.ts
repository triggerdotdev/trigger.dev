import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream, type UIMessage, type UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { investigationSettlementMessage } from "@internal/dashboard-agent-db";

import type {
  DashboardAgentEvalPolicyCheck,
  DashboardAgentEvalTrigger,
  DashboardAgentStore,
} from "./dashboard-agent";

// Scaffolding shared by the agent's test files. Type-only import of the agent
// module, so a test file still controls when the agent registers.

export const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export function finish(unified: LanguageModelV3FinishReason["unified"]): LanguageModelV3StreamPart {
  return { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE };
}

export function textStep(text: string, id = "t1"): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    finish("stop"),
  ];
}

export function toolCallStep(
  toolName: string,
  input: Record<string, unknown> = {},
  toolCallId = "tc1"
): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    finish("tool-calls"),
  ];
}

/**
 * Plays one stream per `streamText` step, plus a `doGenerate` for the background
 * title generation. The last entry in `steps` repeats if the model is called more
 * times than there are steps.
 */
export function mockModel(
  steps: LanguageModelV3StreamPart[][],
  titleText = "Test Chat Title",
  // A test that cares whether the title is awaited has to make it take real time, or
  // it lands within the turn's own await chain either way.
  titleDelayMs = 0
) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = steps[Math.min(call, steps.length - 1)] ?? [];
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
    doGenerate: async () => {
      if (titleDelayMs > 0) await new Promise((r) => setTimeout(r, titleDelayMs));
      return {
        content: [{ type: "text", text: titleText }],
        finishReason: { unified: "stop", raw: "stop" } as const,
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

// Records the persistence the agent performs.
export type StoreCalls = {
  ensureChat: unknown[];
  persistMessages: unknown[];
  appendMessage: unknown[];
  persistTurn: unknown[];
  setChatTitleIfDefault: unknown[];
  upsertInvestigationRevision: unknown[];
  settleInvestigationCard: unknown[];
  seedInvestigation: unknown[];
  /** Every write in the order it happened, for the tests that assert ordering. */
  order: (keyof Omit<StoreCalls, "order">)[];
};

/** An investigation as the fake store holds it: enough to tell whose card it is. */
export type FakeInvestigation = {
  chatId: string;
  projectRef: string;
  environmentRef: string;
  state: { outcome?: string } & Record<string, unknown>;
};

export function fakeStore(options: { investigations?: Map<string, FakeInvestigation> } = {}): {
  store: DashboardAgentStore;
  calls: StoreCalls;
  /** The rows, so a test can assert which cards a lane touched and which it left alone. */
  investigations: Map<string, FakeInvestigation>;
} {
  const calls: StoreCalls = {
    ensureChat: [],
    persistMessages: [],
    appendMessage: [],
    persistTurn: [],
    setChatTitleIfDefault: [],
    upsertInvestigationRevision: [],
    settleInvestigationCard: [],
    seedInvestigation: [],
    order: [],
  };
  const record = <K extends keyof Omit<StoreCalls, "order">>(kind: K, args: unknown) => {
    (calls[kind] as unknown[]).push(args);
    calls.order.push(kind);
  };
  // Revisions bump the way the real query does: latest-wins in the transcript is only
  // testable if a later revision is actually a higher number.
  const revisions = new Map<string, number>();
  const closedCards = new Set<string>();
  const investigations = options.investigations ?? new Map<string, FakeInvestigation>();
  const writeState = (id: string, state: unknown) => {
    const row = investigations.get(id);
    if (row) row.state = state as FakeInvestigation["state"];
  };
  const store: DashboardAgentStore = {
    ensureChat: async (args) => record("ensureChat", args),
    persistMessages: async (args) => record("persistMessages", args),
    appendMessage: async (args) => record("appendMessage", args),
    // Mirrors the real query: the settlements commit with the transcript, and the
    // closing cards are part of the messages the write stores.
    persistTurn: async (args) => {
      const settled: { id: string; revision: number; state: unknown }[] = [];
      const cards: UIMessage[] = [];
      for (const pending of args.settlements ?? []) {
        const result = await store.upsertInvestigationRevision({ ...pending, chatId: args.chatId });
        if (!result.ok) continue;
        const message = investigationSettlementMessage({
          investigationId: result.id,
          revision: result.revision,
          state: pending.state,
        });
        if (!message) throw new Error(`${result.id} settled to a state that isn't renderable`);
        settled.push({ id: result.id, revision: result.revision, state: pending.state });
        cards.push(message as UIMessage);
      }
      const stored = args.messages as UIMessage[];
      const messages = [
        ...stored,
        ...cards.filter((card) => !stored.some((message) => message.id === card.id)),
      ];
      record("persistTurn", { ...args, messages });
      return { settled };
    },
    setChatTitleIfDefault: async (args) => record("setChatTitleIfDefault", args),
    upsertInvestigationRevision: async (args) => {
      record("upsertInvestigationRevision", args);
      const id = args.id ?? "inv_fake";
      const revision = args.id ? (revisions.get(id) ?? 0) + 1 : 0;
      revisions.set(id, revision);
      writeState(id, args.state);
      return { ok: true, id, revision, created: !args.id };
    },
    // Mirrors the real query: the terminal revision and its closing card are one
    // operation, so a card that can't be delivered leaves no settled row behind.
    settleInvestigationCard: async (args) => {
      record("settleInvestigationCard", args);
      const revision = (revisions.get(args.id) ?? 0) + 1;
      const card = investigationSettlementMessage({
        investigationId: args.id,
        revision,
        state: args.state,
        messageId: args.messageId,
      });
      if (!card) throw new Error(`${args.id} settled to a state that isn't renderable`);
      revisions.set(args.id, revision);
      writeState(args.id, args.state);
      const closed = !closedCards.has(args.messageId);
      closedCards.add(args.messageId);
      return { ok: true, id: args.id, revision, card, closed };
    },
    // Mirrors the real query: insert under the caller's id, or hand back the row that
    // is already there — unless it belongs to another chat or environment.
    seedInvestigation: async (args) => {
      record("seedInvestigation", args);
      const existing = investigations.get(args.id);
      if (existing) {
        if (
          existing.chatId !== args.chatId ||
          existing.projectRef !== args.projectRef ||
          existing.environmentRef !== args.environmentRef
        ) {
          return { ok: false, error: "context_mismatch" };
        }
        return { ok: true, id: args.id, created: false };
      }
      investigations.set(args.id, {
        chatId: args.chatId,
        projectRef: args.projectRef,
        environmentRef: args.environmentRef,
        state: args.state as FakeInvestigation["state"],
      });
      revisions.set(args.id, 0);
      return { ok: true, id: args.id, created: true };
    },
  };
  return { store, calls, investigations };
}

// Records the eval enqueues, in place of tasks.trigger.
export function fakeEvalTrigger(): { trigger: DashboardAgentEvalTrigger; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    trigger: async (payload, options) => void calls.push({ payload, options }),
    calls,
  };
}

/** Stands in for the org opt-out check, so no test depends on a network call. */
export function fakeEvalPolicy(allowed = true): DashboardAgentEvalPolicyCheck {
  return async () => allowed;
}

export const CLIENT_DATA = { userId: "user_1", organizationId: "org_1" };

export function userMessage(text: string, id = "u1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

export function collectText(chunks: UIMessageChunk[]): string {
  return chunks
    .filter((c): c is Extract<UIMessageChunk, { type: "text-delta" }> => c.type === "text-delta")
    .map((c) => c.delta)
    .join("");
}

// On a head-start handover the tool-call is supplied by the handover partial rather
// than streamed by the model, so the output chunk is the only reliable signal that
// the call actually ran.
export function executedTool(chunks: UIMessageChunk[]): boolean {
  return chunks.some((c) => (c as { type?: string }).type === "tool-output-available");
}
