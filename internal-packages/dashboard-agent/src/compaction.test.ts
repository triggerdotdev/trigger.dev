// `@trigger.dev/sdk/ai/test` MUST be imported before the agent module so the
// resource catalog is installed before `chat.agent({ id })` registers.
import { mockChatAgent, type MockChatAgentHarness } from "@trigger.dev/sdk/ai/test";

import { afterEach, describe, expect, it } from "vitest";
import { simulateReadableStream, type ModelMessage, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { dashboardAgent, dashboardAgentModelKey, dashboardAgentStoreKey } from "./dashboard-agent";
import {
  CLIENT_DATA,
  fakeStore,
  seedTranscript,
  textStep,
  USAGE,
  userMessage,
} from "./test-support";
import {
  buildCompactedModelMessages,
  collectDurableState,
  COMPACTION_KEPT_TAIL,
  COMPACTION_KEPT_TAIL_CHARS,
  describeDurableState,
  estimateConversationTokens,
  renderTranscriptForSummary,
  safeTail,
  shouldCompactConversation,
  contextTokenBudget,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  withDurableState,
  withoutReasoning,
} from "./compaction";

function text(role: "user" | "assistant", body: string): ModelMessage {
  return { role, content: body };
}

function bulk(count: number, chars: number): ModelMessage[] {
  return Array.from({ length: count }, (_, i) =>
    text(i % 2 === 0 ? "user" : "assistant", "x".repeat(chars))
  );
}

function investigationBlock(args: {
  id: string;
  title: string;
  outcome: string;
  revision?: number;
}) {
  return {
    type: "investigation",
    id: args.id,
    revision: args.revision ?? 0,
    version: 1,
    investigation: {
      outcome: args.outcome,
      severity: "warn",
      confidence: "medium",
      title: args.title,
      headline: `${args.title} — what we have so far.`,
      hypotheses: [],
      evidence: [],
    },
  };
}

/**
 * The card as `render_view` persists it: a tool part, which is the only shape
 * production writes an investigation in.
 */
function investigationMessage(args: {
  id: string;
  title: string;
  outcome: string;
  revision?: number;
}): UIMessage {
  return {
    id: `msg-${args.id}-${args.revision ?? 0}`,
    role: "assistant",
    parts: [
      {
        type: "tool-render_view",
        toolCallId: `call-${args.id}-${args.revision ?? 0}`,
        state: "output-available",
        output: { blocks: [investigationBlock(args)] },
      } as never,
    ],
  };
}

/** The other shape the panel accepts: a host-written view. */
function hostInvestigationMessage(args: {
  id: string;
  title: string;
  outcome: string;
  revision?: number;
}): UIMessage {
  return {
    id: `host-${args.id}-${args.revision ?? 0}`,
    role: "assistant",
    parts: [{ type: "data-view", data: { blocks: [investigationBlock(args)] } } as never],
  };
}

describe("when the conversation is compacted", () => {
  it("stays under the budget for an ordinary conversation", () => {
    expect(shouldCompactConversation({ messages: bulk(20, 500), inputTokens: 22_000 })).toBe(false);
  });

  it("compacts on our own estimate, with no usage reported at all", () => {
    // 4 chars ≈ 1 token, so this is comfortably past the budget.
    const messages = bulk(40, 12_000);
    expect(estimateConversationTokens(messages)).toBeGreaterThan(DEFAULT_CONTEXT_TOKEN_BUDGET);
    expect(shouldCompactConversation({ messages })).toBe(true);
  });

  it("compacts on the context the provider billed for the last call", () => {
    const messages = bulk(4, 100);
    const budget = DEFAULT_CONTEXT_TOKEN_BUDGET;
    expect(shouldCompactConversation({ messages, inputTokens: 39_500 }, budget)).toBe(false);
    expect(shouldCompactConversation({ messages, inputTokens: budget }, budget)).toBe(false);
    expect(shouldCompactConversation({ messages, inputTokens: budget + 1 }, budget)).toBe(true);
  });

  it("takes the context budget from the environment, falling back to the default", () => {
    expect(contextTokenBudget(undefined)).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET);
    expect(contextTokenBudget(" 150000 ")).toBe(150_000);
    expect(contextTokenBudget("0")).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET);
    expect(contextTokenBudget("lots")).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET);
    expect(contextTokenBudget("1e5")).toBe(100_000);
    expect(contextTokenBudget("100k")).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET);
    expect(contextTokenBudget("1.5")).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET);
    const messages = bulk(4, 100);
    expect(
      shouldCompactConversation({ messages, inputTokens: 50_001 }, contextTokenBudget("50000"))
    ).toBe(true);
  });

  it("lets a raised budget stand when the provider count is below it", () => {
    const messages = bulk(40, 12_000);
    expect(estimateConversationTokens(messages)).toBeGreaterThan(DEFAULT_CONTEXT_TOKEN_BUDGET);
    expect(estimateConversationTokens(messages)).toBeLessThan(150_000);
    expect(shouldCompactConversation({ messages, inputTokens: 120_000 }, 150_000)).toBe(false);
    expect(shouldCompactConversation({ messages, inputTokens: 150_001 }, 150_000)).toBe(true);
  });

  it("does not compact a short conversation on a tool-using turn's summed usage", () => {
    const messages = bulk(12, 600);
    expect(shouldCompactConversation({ messages, inputTokens: 39_557 })).toBe(false);
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

  it("pins a card written the way render_view writes one", () => {
    const state = collectDurableState([
      investigationMessage({
        id: "inv_tool",
        title: "orders queue is backing up",
        outcome: "in_progress",
        revision: 1,
      }),
    ]);
    expect(state.investigations.map((i) => i.id)).toEqual(["inv_tool"]);
    expect(
      describeDurableState([
        investigationMessage({
          id: "inv_tool",
          title: "orders queue is backing up",
          outcome: "in_progress",
          revision: 1,
        }),
      ])
    ).toContain("inv_tool");
  });

  // The emitted title holds inline links to whatever the turn read. Pinning them would
  // put URIs in the prompt and teach the model to hand a stale one back.
  it("pins the card's title as plain prose, with its links stripped", () => {
    const linked =
      "[task/orders](trigger://proj_1/env_1/queue/task%2Forders) is backing up for" +
      " [run_abc123](trigger://proj_1/env_1/run/run_abc123)";
    const messages = [
      investigationMessage({ id: "inv_linked", title: linked, outcome: "in_progress" }),
    ];
    expect(collectDurableState(messages).investigations[0]!.title).toBe(
      "task/orders is backing up for run_abc123"
    );
    const note = describeDurableState(messages)!;
    expect(note).not.toContain("trigger://");
    expect(note).not.toMatch(/\]\(/);
  });

  it("pins a card a host view wrote, too", () => {
    const state = collectDurableState([
      hostInvestigationMessage({ id: "inv_host", title: "host card", outcome: "in_progress" }),
    ]);
    expect(state.investigations.map((i) => i.id)).toEqual(["inv_host"]);
  });

  it("keeps a settled card closed when a stale render arrives after it", () => {
    const settledThenStale = [
      investigationMessage({
        id: "inv_1",
        title: "first pass",
        outcome: "in_progress",
        revision: 0,
      }),
      investigationMessage({ id: "inv_1", title: "first pass", outcome: "concluded", revision: 3 }),
      // A late replay of an earlier revision: lower, so it loses whatever order it lands in.
      investigationMessage({
        id: "inv_1",
        title: "first pass",
        outcome: "in_progress",
        revision: 1,
      }),
    ];
    expect(collectDurableState(settledThenStale).investigations).toEqual([]);
    expect(describeDurableState(settledThenStale)).toBeUndefined();
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

  /** An oversized prior conversation, loaded from the agent's storage at boot. */
  const FILLER = "the queue was busy. ".repeat(20_000);

  async function runOverBudget(args: {
    chatId: string;
    seeded: UIMessage[];
    prompts: string[];
    summarized?: string[];
  }) {
    const { store } = fakeStore();
    await seedTranscript(store, {
      chatId: args.chatId,
      clientData: CLIENT_DATA,
      messages: [
        ...args.seeded,
        { id: "a0", role: "assistant", parts: [{ type: "text", text: FILLER }] },
      ],
    });
    return mockChatAgent(dashboardAgent, {
      chatId: args.chatId,
      clientData: CLIENT_DATA,
      // Storage is only read on a boot that could have prior state.
      continuation: true,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, capturingModel(args.prompts, args.summarized));
      },
    });
  }

  it("shortens an oversized history but keeps the open investigation revisable", async () => {
    const prompts: string[] = [];
    harness = await runOverBudget({
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

describe("the kept tail after a summary", () => {
  const reasoning = {
    type: "reasoning" as const,
    text: "",
    providerOptions: { anthropic: { signature: "sig" } },
  };
  const tail: ModelMessage[] = [
    { role: "user", content: "what failed?" },
    {
      role: "assistant",
      content: [
        reasoning,
        { type: "tool-call", toolCallId: "c1", toolName: "list_errors", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "list_errors",
          output: { type: "text", value: "[]" },
        },
      ],
    },
    { role: "assistant", content: [reasoning, { type: "text", text: "Nothing failed." }] },
    { role: "assistant", content: [reasoning] },
  ];

  it("drops the reasoning a summary invalidated and keeps everything else", () => {
    const stripped = withoutReasoning(tail);
    expect(JSON.stringify(stripped)).not.toContain('"reasoning"');
    // The reasoning-only message goes; the calls, results and text stay in order.
    expect(stripped.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(stripped[1]!.content).toEqual([
      { type: "tool-call", toolCallId: "c1", toolName: "list_errors", input: {} },
    ]);
  });

  it("builds the compacted history with no reasoning in the tail", () => {
    const compacted = buildCompactedModelMessages({
      summary: "The user asked what failed.",
      uiMessages: [],
      modelMessages: tail.slice(0, 4),
    });
    expect(JSON.stringify(compacted)).not.toContain('"reasoning"');
    expect(compacted.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Nothing failed." }],
    });
  });
});
