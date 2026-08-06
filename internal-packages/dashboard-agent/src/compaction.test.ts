// `@trigger.dev/sdk/ai/test` MUST be imported before the agent module so the
// resource catalog is installed before `chat.agent({ id })` registers.
import { mockChatAgent, type MockChatAgentHarness } from "@trigger.dev/sdk/ai/test";

import { afterEach, describe, expect, it } from "vitest";
import { simulateReadableStream, type ModelMessage, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { dashboardAgent, dashboardAgentModelKey, dashboardAgentStoreKey } from "./dashboard-agent";
import { CLIENT_DATA, fakeStore, textStep, USAGE, userMessage } from "./test-support";
import {
  buildCompactedModelMessages,
  collectDurableState,
  COMPACTION_KEPT_TAIL,
  COMPACTION_KEPT_TAIL_CHARS,
  CONVERSATION_TOKEN_BUDGET,
  describeDurableState,
  estimateConversationTokens,
  renderTranscriptForSummary,
  safeTail,
  shouldCompactConversation,
  STATIC_PREFIX_TOKENS,
  withDurableState,
} from "./compaction";

function text(role: "user" | "assistant", body: string): ModelMessage {
  return { role, content: body };
}

function bulk(count: number, chars: number): ModelMessage[] {
  return Array.from({ length: count }, (_, i) =>
    text(i % 2 === 0 ? "user" : "assistant", "x".repeat(chars))
  );
}

/** The card, as `render_view` persisted it into the transcript. */
function investigationMessage(args: {
  id: string;
  title: string;
  outcome: string;
  revision?: number;
}): UIMessage {
  return {
    id: `msg-${args.id}`,
    role: "assistant",
    parts: [
      {
        type: "data-view",
        data: {
          blocks: [
            {
              type: "investigation",
              id: args.id,
              revision: args.revision ?? 0,
              version: 1,
              investigation: { title: args.title, outcome: args.outcome },
            },
          ],
        },
      } as never,
    ],
  };
}

describe("when the conversation is compacted", () => {
  it("stays under the budget for an ordinary conversation", () => {
    expect(shouldCompactConversation({ messages: bulk(20, 500), inputTokens: 22_000 })).toBe(false);
  });

  it("compacts on our own estimate, with no usage reported at all", () => {
    // 4 chars ≈ 1 token, so this is comfortably past the budget.
    const messages = bulk(40, (CONVERSATION_TOKEN_BUDGET * 4) / 20);
    expect(estimateConversationTokens(messages)).toBeGreaterThan(CONVERSATION_TOKEN_BUDGET);
    expect(shouldCompactConversation({ messages })).toBe(true);
  });

  it("compacts on the provider's input count, net of the static prefix", () => {
    const messages = bulk(4, 100);
    // The prefix alone must never trigger it.
    expect(shouldCompactConversation({ messages, inputTokens: STATIC_PREFIX_TOKENS + 100 })).toBe(
      false
    );
    expect(
      shouldCompactConversation({
        messages,
        inputTokens: STATIC_PREFIX_TOKENS + CONVERSATION_TOKEN_BUDGET + 1,
      })
    ).toBe(true);
  });
});

describe("the state a summary may not swallow", () => {
  it("keeps an open investigation revisable across the boundary", () => {
    const uiMessages: UIMessage[] = [
      investigationMessage({
        id: "inv_abc123",
        title: "send-order-receipt fails on retry",
        outcome: "in_progress",
        revision: 2,
      }),
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: `noise ${i}` }],
      })),
    ];

    const compacted = buildCompactedModelMessages({
      // Deliberately a summary that forgot the card: the pin is not allowed to
      // depend on the summariser mentioning it.
      summary: "The user asked about failures. Nothing else worth keeping.",
      uiMessages,
      modelMessages: bulk(30, 200),
    });

    const first = String(compacted[0]!.content);
    expect(first).toContain("inv_abc123");
    expect(first).toContain("in_progress");
    expect(first).toContain("send-order-receipt fails on retry");
    // The instruction matters as much as the id: this is what stops a second card.
    expect(first).toContain("never open a second card");
  });

  it("pins the freshest revision of one card, not one entry per render", () => {
    const state = collectDurableState([
      investigationMessage({
        id: "inv_1",
        title: "first pass",
        outcome: "in_progress",
        revision: 0,
      }),
      investigationMessage({
        id: "inv_1",
        title: "first pass",
        outcome: "in_progress",
        revision: 3,
      }),
    ]);
    expect(state.investigations).toEqual([
      { id: "inv_1", title: "first pass", outcome: "in_progress", revision: 3 },
    ]);
  });

  it("stops pinning a card once it has settled", () => {
    const settled = [
      investigationMessage({
        id: "inv_1",
        title: "first pass",
        outcome: "in_progress",
        revision: 0,
      }),
      investigationMessage({ id: "inv_1", title: "first pass", outcome: "concluded", revision: 3 }),
    ];
    expect(collectDurableState(settled).investigations).toEqual([]);
    expect(describeDurableState(settled)).toBeUndefined();

    // …and only that card: one still running alongside it stays pinned.
    const mixed = [
      ...settled,
      investigationMessage({ id: "inv_2", title: "second pass", outcome: "in_progress" }),
    ];
    expect(collectDurableState(mixed).investigations.map((i) => i.id)).toEqual(["inv_2"]);
  });

  it("pins the same state onto the between-steps rebuild path", () => {
    const rebuilt: ModelMessage[] = [
      text("user", "[Conversation summary]\n\nsome summary"),
      text("assistant", "a later step"),
    ];
    const withState = withDurableState(rebuilt, [
      investigationMessage({ id: "inv_x", title: "queue backing up", outcome: "in_progress" }),
    ]);

    expect(withState).toHaveLength(3);
    expect(String(withState[1]!.content)).toContain("inv_x");
    // The summary stays first and the later step stays last.
    expect(withState[0]).toEqual(rebuilt[0]);
    expect(withState[2]).toEqual(rebuilt[1]);
  });

  it("leaves a history alone when there is nothing live to pin", () => {
    const messages = [text("user", "summary"), text("assistant", "step")];
    expect(withDurableState(messages, [])).toBe(messages);
  });
});

describe("the kept tail", () => {
  it("stops at the character cap, so one huge message can't ride back in", () => {
    const messages = [
      text("user", "a question"),
      text("assistant", "z".repeat(COMPACTION_KEPT_TAIL_CHARS * 2)),
      text("user", "and now?"),
      text("assistant", "answered"),
    ];
    expect(safeTail(messages, COMPACTION_KEPT_TAIL)).toEqual([messages[2], messages[3]]);
  });

  it("keeps the last message even when it alone is over the cap", () => {
    const messages = [
      text("user", "q"),
      text("assistant", "z".repeat(COMPACTION_KEPT_TAIL_CHARS * 2)),
    ];
    expect(safeTail(messages, COMPACTION_KEPT_TAIL)).toEqual([messages[1]]);
  });

  it("keeps the last few messages verbatim", () => {
    const messages = bulk(30, 50);
    const compacted = buildCompactedModelMessages({
      summary: "s",
      uiMessages: [],
      modelMessages: messages,
    });
    expect(compacted).toHaveLength(COMPACTION_KEPT_TAIL + 1);
    expect(compacted.at(-1)).toEqual(messages.at(-1));
  });

  it("never starts on a tool result whose call was summarised away", () => {
    const messages: ModelMessage[] = [
      text("user", "q"),
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "get_run", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_run",
            output: { type: "json", value: {} },
          },
        ],
      },
      text("assistant", "answer"),
    ];
    expect(safeTail(messages, 2)).toEqual([messages[3]]);
  });

  it("never ends on a tool call whose result is missing", () => {
    const messages: ModelMessage[] = [
      text("user", "q"),
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "get_run", input: {} }],
      },
    ];
    expect(safeTail(messages, 4)).toEqual([messages[0]]);
  });
});

describe("the summariser's input", () => {
  it("caps each message so summarising a huge history is bounded too", () => {
    const rendered = renderTranscriptForSummary([text("user", "y".repeat(50_000))]);
    expect(rendered.length).toBeLessThan(2_100);
    expect(rendered.startsWith("user: ")).toBe(true);
  });
});

/** Records what each model call was actually given, and summarises predictably. */
function capturingModel(prompts: string[], summarized: string[] = []) {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return { stream: simulateReadableStream({ chunks: textStep("answered") }) };
    },
    doGenerate: async (options) => {
      summarized.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text" as const, text: "SUMMARY-OF-THE-CHAT" }],
        finishReason: { unified: "stop", raw: "stop" } as const,
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

describe("dashboardAgent compaction (mock harness)", () => {
  let harness: MockChatAgentHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** An oversized prior conversation, replayed from the boot snapshot. */
  const FILLER = "the queue was busy. ".repeat(20_000);

  function runOverBudget(args: {
    chatId: string;
    seeded: UIMessage[];
    prompts: string[];
    summarized?: string[];
  }) {
    const { store } = fakeStore();
    return mockChatAgent(dashboardAgent, {
      chatId: args.chatId,
      clientData: CLIENT_DATA,
      // The snapshot is only read on a boot that could have prior state.
      continuation: true,
      snapshot: {
        version: 1,
        savedAt: Date.now(),
        messages: [
          ...args.seeded,
          { id: "a0", role: "assistant", parts: [{ type: "text", text: FILLER }] },
        ],
      },
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, capturingModel(args.prompts, args.summarized));
      },
    });
  }

  it("shortens an oversized history but keeps the open investigation revisable", async () => {
    const prompts: string[] = [];
    harness = runOverBudget({
      chatId: "chat_compaction_investigation",
      prompts,
      seeded: [
        userMessage("why is send-order-receipt failing?", "u0"),
        investigationMessage({
          id: "inv_abc123",
          title: "send-order-receipt fails on retry",
          outcome: "in_progress",
          revision: 1,
        }),
      ],
    });

    await harness.sendMessage(userMessage("what did you find?", "u1"));
    await harness.sendMessage(userMessage("and now?", "u2"));

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    // The oversized history is gone…
    expect(prompts[0]!.length).toBeGreaterThan(FILLER.length);
    expect(prompts.at(-1)!.length).toBeLessThan(FILLER.length);
    expect(prompts.at(-1)!).toContain("SUMMARY-OF-THE-CHAT");
    // …and the card the next render has to revise came through with it.
    expect(prompts.at(-1)!).toContain("inv_abc123");
    expect(prompts.at(-1)!).toContain("never open a second card");
  });
});
