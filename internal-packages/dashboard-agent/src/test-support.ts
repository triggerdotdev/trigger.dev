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
  findOpenInvestigation: unknown[];
  /** Every write in the order it happened, for the tests that assert ordering. */
  order: (keyof Omit<StoreCalls, "order">)[];
};

export function fakeStore(
  options: { openInvestigation?: { id: string; projectRef: string; environmentRef: string } } = {}
): { store: DashboardAgentStore; calls: StoreCalls } {
  const calls: StoreCalls = {
    ensureChat: [],
    persistMessages: [],
    appendMessage: [],
    persistTurn: [],
    setChatTitleIfDefault: [],
    upsertInvestigationRevision: [],
    findOpenInvestigation: [],
    order: [],
  };
  const record = <K extends keyof Omit<StoreCalls, "order">>(kind: K, args: unknown) => {
    (calls[kind] as unknown[]).push(args);
    calls.order.push(kind);
  };
  // Revisions bump the way the real query does: latest-wins in the transcript is only
  // testable if a later revision is actually a higher number.
  const revisions = new Map<string, number>();
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
      return { ok: true, id, revision, created: !args.id };
    },
    findOpenInvestigation: async (args) => {
      record("findOpenInvestigation", args);
      return options.openInvestigation ?? null;
    },
  };
  return { store, calls };
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
