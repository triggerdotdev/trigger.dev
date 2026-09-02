// `@trigger.dev/sdk/ai/test` MUST be imported before the agent module so the
// resource catalog is installed before `chat.agent({ id })` / `prompts.define`
// register at module load.
import { mockChatAgent, type MockChatAgentHarness } from "@trigger.dev/sdk/ai/test";

import {
  convertToModelMessages,
  simulateReadableStream,
  tool,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { disposeRepoWorkspaces, workdirFor, type RepoSnapshot } from "./repo-tools";
import {
  clientDataSchema,
  dashboardAgent,
  dashboardAgentEvalPolicyKey,
  dashboardAgentEvalTriggerKey,
  dashboardAgentModelKey,
  dashboardAgentStoreKey,
  dashboardAgentTitleDeadlineKey,
  dashboardAgentToolsKey,
  DEFAULT_CI_EVAL_SAMPLE_RATE,
  DEFAULT_EVAL_SAMPLE_RATE,
  evalSampleRate,
  extractToolActivity,
  isCiEvalContext,
  isFirstUserExchange,
  MAX_EVAL_TOOL_OUTPUT_CHARS,
  prepareTurnMessages,
  sanitizeReplayedToolInputs,
  truncateEvalToolOutput,
  TOOL_FAILED_MESSAGE,
  TURN_FAILED_MESSAGE,
  turnFailureMessageId,
  type DashboardAgentEvalPolicyCheck,
  type DashboardAgentStore,
} from "./dashboard-agent";
import { orgAllowsTurnEvals, redactEvalToolValue } from "./eval-policy";
import {
  CLIENT_DATA,
  collectText,
  executedTool,
  fakeEvalPolicy,
  fakeEvalTrigger,
  fakeStore,
  mockModel,
  textStep,
  toolCallStep,
  USAGE,
  userMessage,
  type StoreCalls,
} from "./test-support";
import { buildDashboardAgentTools } from "./tools";

describe("dashboardAgent (mock harness)", () => {
  let harness: MockChatAgentHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("streams the model's response and persists the turn", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_text",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("hello from the agent")]));
      },
    });

    const turn = await harness.sendMessage(userMessage("hi"));

    expect(collectText(turn.chunks)).toBe("hello from the agent");

    expect(calls.ensureChat).toHaveLength(1);
    expect(calls.persistMessages).toHaveLength(1);
    // onTurnComplete persists after the turn-complete chunk, so give it a tick.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.persistTurn).toHaveLength(1);
  });

  // The panel reloads its chat list once, when the turn settles, so the title write
  // must land before the turn-complete chunk.
  it("has written the generated chat title by the time the turn settles", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_title",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        // 50ms so the title outlives the response: without the await in
        // `onBeforeTurnComplete` the turn would settle before the write.
        set(dashboardAgentModelKey, mockModel([textStep("answered")], "Why orders fail", 50));
      },
    });

    await harness.sendMessage(userMessage("why do my orders fail?"));

    // Deliberately no `await setTimeout` here: that is the whole assertion.
    expect(calls.setChatTitleIfDefault).toEqual([
      { chatId: "chat_title", title: "Why orders fail" },
    ]);
  });

  // A provider request that stalls instead of failing has no deadline of its own, so
  // the await that collects the title used to hang the whole turn after the model's
  // final word: nothing streamed, nothing persisted, and the run never ended.
  it("settles the turn when the title generation never comes back (regression)", async () => {
    const { store, calls } = fakeStore();
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: textStep("answered") }) }),
      doGenerate: (() => new Promise(() => {})) as never,
    });
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_title_stalled",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
        set(dashboardAgentTitleDeadlineKey, 30);
      },
    });

    const turn = await harness.sendMessage(userMessage("why do my orders fail?"));

    expect(collectText(turn.chunks)).toBe("answered");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.persistTurn).toHaveLength(1);
    expect(calls.setChatTitleIfDefault).toHaveLength(0);
  }, 10_000);

  describe("which turn names the chat", () => {
    const user = (id: string) => ({ id, role: "user" });
    const assistant = (id: string) => ({ id, role: "assistant" });

    it("names it on the first exchange", () => {
      expect(isFirstUserExchange([user("u1")])).toBe(true);
    });

    it("still names it when the turn was head-started", () => {
      // The warm first step arrives in `uiMessages`, so the transcript already holds
      // two messages on the very first exchange.
      expect(isFirstUserExchange([user("u1"), assistant("a1")])).toBe(true);
    });

    it("does not rename on a later exchange", () => {
      expect(isFirstUserExchange([user("u1"), assistant("a1"), user("u2")])).toBe(false);
    });

    it("ignores a watch consent record, which the user never typed", () => {
      expect(isFirstUserExchange([user("watch-request:watch_1"), user("u1")])).toBe(true);
    });
  });

  it("names the chat once, not on every turn", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_title_once",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("first"), textStep("second")]));
      },
    });

    await harness.sendMessage(userMessage("first question", "u1"));
    // A distinct id: two turns are two messages, which is what the gate counts.
    await harness.sendMessage(userMessage("second question", "u2"));

    expect(calls.setChatTitleIfDefault).toHaveLength(1);
  });

  it("executes a read tool the model calls, then answers from the result", async () => {
    const { store } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_tool",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(
          dashboardAgentModelKey,
          mockModel([toolCallStep("list_errors"), textStep("you have no errors")])
        );
      },
    });

    const turn = await harness.sendMessage(userMessage("any errors?"));

    // No delegated token in clientData, so the tool returns its no-auth result and
    // never touches the network.
    expect(executedTool(turn.chunks)).toBe(true);
    expect(collectText(turn.chunks)).toBe("you have no errors");
  });

  it("rolls an Anthropic cache breakpoint onto the last message", async () => {
    const { store } = fakeStore();
    const model = mockModel([textStep("cached")]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_cache",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendMessage(userMessage("hi"));

    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    const last = prompt[prompt.length - 1] as { providerOptions?: Record<string, unknown> };
    expect(last?.providerOptions?.anthropic).toMatchObject({
      cacheControl: { type: "ephemeral" },
    });
  });

  // Resending the same message id merges onto the user message already in history
  // instead of appending after it, so the turn-failure record would be the last
  // message — and the newer Anthropic models reject a request that ends with one.
  it("a retried turn never sends the failure record as an assistant prefill (regression)", async () => {
    const { store } = fakeStore();
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++;
        if (call === 1) throw new Error("the provider failed");
        return { stream: simulateReadableStream({ chunks: textStep("recovered") }) };
      },
      doGenerate: async () => ({
        content: [{ type: "text", text: "Why it fails" }],
        finishReason: { unified: "stop", raw: "stop" } as const,
        usage: USAGE,
        warnings: [],
      }),
    });
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_retry_prefill",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    await harness.sendMessage(userMessage("why is it failing?", "u1"));
    await new Promise((r) => setTimeout(r, 30));
    const turn = await harness.sendMessage(userMessage("why is it failing?", "u1"));

    const prompt = model.doStreamCalls[1]?.prompt ?? [];
    expect(prompt[prompt.length - 1]?.role).not.toBe("assistant");
    expect(collectText(turn.chunks)).toBe("recovered");
  });

  it("Head Start handover: executes the handed-over tool call despite the cache hook (regression)", async () => {
    const { store } = fakeStore();
    // Only step 2 runs in the agent: the warm route did step 1 and hands over the
    // pending tool call.
    const model = mockModel([textStep("resolved from the tool")]);
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_headstart",
      clientData: CLIENT_DATA,
      mode: "handover-prepare",
      headStartMessages: [userMessage("what errors are happening?")],
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, model);
      },
    });

    // The partial chat.headStart sends on a tool-calls finish: a tool-approval round
    // whose trailing tool message must survive prepareMessages for
    // collectToolApprovals to execute the pending call.
    const toolCallId = "tc_hs";
    const approvalId = "ap_hs";
    const turn = await harness.sendHandover({
      partialAssistantMessage: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId, toolName: "list_errors", input: {} },
            { type: "tool-approval-request", approvalId, toolCallId },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-approval-response", approvalId, approved: true }],
        },
      ],
      isFinal: false,
    });

    // Without the SDK's preserveToolApprovalTail guard the bare tool_use would never
    // execute, so there would be no tool output.
    expect(executedTool(turn.chunks)).toBe(true);
    expect(collectText(turn.chunks)).toBe("resolved from the tool");
  });

  // An investigation needs a project and environment to be scoped.
  const INVESTIGATION_CLIENT_DATA = {
    ...CLIENT_DATA,
    projectRef: "proj_abc",
    environmentId: "env_abc",
  };

  const openInvestigation = {
    outcome: "in_progress",
    severity: "warn",
    confidence: "medium",
    runId: "run_abc123",
    title: "Why is send-order-receipt failing?",
    headline: "Every attempt came back 429 from the email provider.",
    progress: "Reading the run's spans",
    hypotheses: [
      {
        id: "hyp_rate_limit",
        statement: "The provider is rate limiting this API key.",
        verdict: "testing",
        evidence: [],
      },
    ],
    evidence: [],
  };

  const renderViewStep = (investigation: Record<string, unknown>, toolCallId: string) =>
    toolCallStep("render_view", { blocks: [{ type: "investigation", investigation }] }, toolCallId);

  // The store's view after the turn: what a refresh reads.
  const finalInvestigationState = (calls: StoreCalls) =>
    (calls.upsertInvestigationRevision[calls.upsertInvestigationRevision.length - 1] as {
      state: Record<string, any>;
    })!.state;

  it("settles an investigation the turn left in progress", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_open_investigation",
      clientData: INVESTIGATION_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        // The model opens the card and then only talks, with no verdict render.
        set(
          dashboardAgentModelKey,
          mockModel([renderViewStep(openInvestigation, "tc_open"), textStep("still looking")])
        );
      },
    });

    await harness.sendMessage(userMessage("why is send-order-receipt failing?"));
    await new Promise((r) => setTimeout(r, 30));

    expect(calls.upsertInvestigationRevision).toHaveLength(2);
    const settle = calls.upsertInvestigationRevision[1] as Record<string, any>;
    expect(settle.id).toBe("inv_fake");
    expect(settle.chatId).toBe("chat_open_investigation");
    expect(settle.projectRef).toBe("proj_abc");
    expect(settle.environmentRef).toBe("env_abc");

    const state = finalInvestigationState(calls);
    expect(state.outcome).toBe("inconclusive");
    // No spinner, no invented cause, no fix, and the facts the turn established stay.
    expect(state.progress).toBeUndefined();
    expect(state.remediation).toBeUndefined();
    expect(state.confidence).toBe("low");
    expect(state.headline).toContain("didn't conclude within this turn");
    expect(state.headline).toContain("429");
    expect(state.hypotheses).toHaveLength(1);
  });

  /**
   * The transcript a fresh page load reads. One write holds all of it: the terminal
   * settlement goes into the same array `persistTurn` stores.
   */
  const storedTranscript = (calls: StoreCalls): UIMessage[] => {
    const last = calls.persistTurn[calls.persistTurn.length - 1] as
      | { messages: UIMessage[] }
      | undefined;
    return [...(last?.messages ?? [])];
  };

  /** Mirrors the panel's winning-revision logic, over `tool-render_view` output blocks. */
  const winningCards = (messages: UIMessage[]) => {
    const latest = new Map<string, { revision: number; outcome?: string; progress?: string }>();
    for (const message of messages) {
      for (const part of message.parts ?? []) {
        const typed = part as { type?: string; output?: { blocks?: unknown[] } };
        if (typed.type !== "tool-render_view" || !Array.isArray(typed.output?.blocks)) continue;
        for (const block of typed.output.blocks) {
          const candidate = block as {
            type?: string;
            id?: string;
            revision?: number;
            investigation?: { outcome?: string; progress?: string };
          };
          if (candidate.type !== "investigation" || typeof candidate.id !== "string") continue;
          const revision = typeof candidate.revision === "number" ? candidate.revision : 0;
          const current = latest.get(candidate.id);
          if (!current || revision >= current.revision) {
            latest.set(candidate.id, {
              revision,
              outcome: candidate.investigation?.outcome,
              progress: candidate.investigation?.progress,
            });
          }
        }
      }
    }
    return latest;
  };

  // The settled row is invisible: the panel builds the card from the transcript's own
  // render_view parts, so a turn that ran out of steps left a permanent spinner.
  it("a turn that runs out of steps closes its card IN THE TRANSCRIPT, not only in the row", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_transcript_settle",
      clientData: INVESTIGATION_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(
          dashboardAgentModelKey,
          mockModel([renderViewStep(openInvestigation, "tc_open"), textStep("still looking")])
        );
      },
    });

    await harness.sendMessage(userMessage("why is send-order-receipt failing?"));
    await new Promise((r) => setTimeout(r, 30));

    const stored = storedTranscript(calls);
    const settlement = stored.filter((m) => m.id.startsWith("investigation-settlement:"));
    expect(settlement.map((m) => m.id)).toEqual(["investigation-settlement:inv_fake:1"]);

    const part = settlement[0]!.parts[0] as {
      type: string;
      state: string;
      output: { blocks: Record<string, any>[] };
    };
    expect(part.type).toBe("tool-render_view");
    expect(part.state).toBe("output-available");
    expect(part.output.blocks[0]).toMatchObject({
      type: "investigation",
      id: "inv_fake",
      revision: 1,
      version: 1,
    });
    expect(part.output.blocks[0]!.investigation.outcome).toBe("inconclusive");

    // The card the panel resolves is the terminal one, at the higher revision.
    const card = winningCards(stored).get("inv_fake");
    expect(card).toMatchObject({ revision: 1, outcome: "inconclusive" });
    expect(card?.progress).toBeUndefined();
  });

  /**
   * The failure window. Settling the row used to be its own operation, so a transcript
   * write that failed afterwards left a row that was already terminal and a card that
   * said `in_progress`. The stale sweep only selects `in_progress` rows, so nothing
   * could ever repair it. The row and its card must land together or not at all.
   */
  it("a failed transcript write settles nothing, and the retry closes the card", async () => {
    const { store, calls } = fakeStore();
    const attempted: unknown[] = [];
    let failNext = true;
    const flaky: DashboardAgentStore = {
      ...store,
      persistTurn: async (args) => {
        attempted.push(args.settlements);
        if (failNext) {
          failNext = false;
          throw new Error("the transcript write failed");
        }
        return store.persistTurn(args);
      },
    };

    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_settle_write_fails",
      clientData: INVESTIGATION_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, flaky);
        set(
          dashboardAgentModelKey,
          mockModel([renderViewStep(openInvestigation, "tc_open"), textStep("still looking")])
        );
      },
    });

    await harness.sendMessage(userMessage("why is send-order-receipt failing?"));
    await new Promise((r) => setTimeout(r, 30));

    // The settlement is handed to the one write that also stores the transcript, and it
    // is still pending on the retry — the failed attempt committed no row of its own.
    expect(attempted).toHaveLength(2);
    expect(attempted[0]).toMatchObject([{ id: "inv_fake", projectRef: "proj_abc" }]);
    expect(attempted[1]).toMatchObject([{ id: "inv_fake", projectRef: "proj_abc" }]);

    // Exactly one settling revision, written by the attempt that stored the transcript:
    // the model's render, then the settle. Never a settle without its card.
    expect(calls.upsertInvestigationRevision).toHaveLength(2);
    expect(calls.persistTurn).toHaveLength(1);
    expect(calls.appendMessage).toHaveLength(0);

    // And the retry's transcript carries the terminal card.
    const card = winningCards(storedTranscript(calls)).get("inv_fake");
    expect(card).toMatchObject({ revision: 1, outcome: "inconclusive" });
  });

  it("a refresh renders the closed card: the next load's transcript carries it", async () => {
    const { store, calls } = fakeStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_transcript_reload",
      clientData: INVESTIGATION_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(
          dashboardAgentModelKey,
          mockModel([
            renderViewStep(openInvestigation, "tc_open"),
            textStep("still looking"),
            textStep("nothing new"),
          ])
        );
      },
    });

    await harness.sendMessage(userMessage("why is send-order-receipt failing?"));
    await new Promise((r) => setTimeout(r, 30));

    // What the panel would render on a fresh load, before anyone asks anything else.
    expect(winningCards(storedTranscript(calls)).get("inv_fake")?.outcome).toBe("inconclusive");

    // And the next turn's wholesale write keeps it: the transcript it starts from is
    // the one a reload reads.
    await harness.sendMessage(userMessage("anything else?"));
    await new Promise((r) => setTimeout(r, 30));

    const reloaded = (calls.persistMessages[1] as { messages: UIMessage[] }).messages;
    expect(winningCards(reloaded).get("inv_fake")).toMatchObject({
      revision: 1,
      outcome: "inconclusive",
    });
    // One settlement, not one per turn.
    expect(
      reloaded.filter((message) => message.id.startsWith("investigation-settlement:"))
    ).toHaveLength(1);
  });

  it("leaves a concluded investigation alone", async () => {
    const { store, calls } = fakeStore();
    const concluded = {
      ...openInvestigation,
      outcome: "concluded",
      confidence: "high",
      progress: undefined,
      remediation: "Raise minTimeoutInMs to 30s with a factor of 2.",
      hypotheses: [
        {
          ...openInvestigation.hypotheses[0]!,
          verdict: "validated",
          finding: "All three attempts returned 429 inside 20 seconds.",
        },
      ],
    };
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_concluded_investigation",
      clientData: INVESTIGATION_CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(
          dashboardAgentModelKey,
          mockModel([
            renderViewStep(openInvestigation, "tc_open"),
            renderViewStep(concluded, "tc_verdict"),
            textStep("Rate limited — the retries all land in one window."),
          ])
        );
      },
    });

    await harness.sendMessage(userMessage("why is send-order-receipt failing?"));
    await new Promise((r) => setTimeout(r, 30));

    // Two renders, no third write: a turn that settled its own card is untouched.
    expect(calls.upsertInvestigationRevision).toHaveLength(2);
    const state = finalInvestigationState(calls);
    expect(state.outcome).toBe("concluded");
    expect(state.remediation).toBe("Raise minTimeoutInMs to 30s with a factor of 2.");
  });
});

describe("prepareTurnMessages", () => {
  const prepared = (messages: unknown[]) =>
    prepareTurnMessages({ messages: messages as ModelMessage[], reason: "run" });

  // Anthropic's newer models reject a trailing assistant message outright, so no
  // turn may ever send one.
  it("drops the trailing assistant messages history can end with", () => {
    const messages = [
      { role: "user", content: "why is it failing?" },
      { role: "assistant", content: [{ type: "text", text: TURN_FAILED_MESSAGE }] },
    ];

    const result = prepared(messages);

    expect(result.map((message) => message.role)).toEqual(["user"]);
    // The breakpoint follows the new last message.
    expect(
      (result[0] as { providerOptions?: Record<string, unknown> }).providerOptions?.anthropic
    ).toBeDefined();
  });

  it("leaves a history that already ends with the user alone", () => {
    const messages = [
      { role: "user", content: "why is it failing?" },
      { role: "assistant", content: [{ type: "text", text: TURN_FAILED_MESSAGE }] },
      { role: "user", content: "asking again" },
    ];

    expect(prepared(messages).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });
});

describe("sanitizeReplayedToolInputs", () => {
  it("coerces empty-string and null tool inputs to {} and leaves everything else alone", () => {
    const messages = [
      { role: "user", content: "investigate this" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "get_report", input: "" },
          // `typeof null === "object"`, which the API rejects with "Input should be an
          // object".
          { type: "tool-call", toolCallId: "tc2", toolName: "list_errors", input: null },
          { type: "tool-call", toolCallId: "tc3", toolName: "get_run", input: { runId: "r1" } },
          { type: "text", text: "looking..." },
        ],
      },
    ] as Parameters<typeof sanitizeReplayedToolInputs>[0];

    const [user, assistant] = sanitizeReplayedToolInputs(messages);
    expect(user).toBe(messages[0]);
    const parts = (assistant as { content: Array<{ input?: unknown }> }).content;
    expect(parts[0]!.input).toEqual({});
    expect(parts[1]!.input).toEqual({});
    expect(parts[2]!.input).toEqual({ runId: "r1" });
    expect(parts[3]).toBe((messages[1] as { content: unknown[] }).content[3]);
  });
});

describe("the eval judge payload", () => {
  it("passes a small tool output through untouched", () => {
    const output = { type: "json", value: { runs: [{ id: "run_1" }] } };
    expect(truncateEvalToolOutput(output)).toBe(output);
    expect(truncateEvalToolOutput(undefined)).toBeUndefined();
  });

  it("caps a large tool output at the prefix, and says it is one", () => {
    const output = { type: "json", value: { content: "x".repeat(50_000) } };
    const capped = truncateEvalToolOutput(output) as {
      truncated: boolean;
      outputPrefix: string;
      note: string;
    };

    expect(capped.truncated).toBe(true);
    expect(capped.outputPrefix).toHaveLength(MAX_EVAL_TOOL_OUTPUT_CHARS);
    expect(capped.note).toContain("truncated");
    expect(JSON.stringify(capped).length).toBeLessThan(MAX_EVAL_TOOL_OUTPUT_CHARS + 200);
  });

  it("caps every tool result it pairs up, and keeps the inputs", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "get_run", input: { runId: "run_1" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_run",
            output: { type: "json", value: { spans: "y".repeat(80_000) } },
          },
        ],
      },
    ] as Parameters<typeof extractToolActivity>[0];

    const activity = extractToolActivity(messages);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.input).toEqual({ runId: "run_1" });
    expect(activity[0]!.output).toMatchObject({ spans: { redacted: "spans", chars: 80_000 } });
    // The prompt line the judge actually receives, unindented.
    expect(JSON.stringify(activity).length).toBeLessThan(2_000);
  });

  it("replaces the customer's own data with its shape, at any depth", () => {
    const redacted = redactEvalToolValue({
      runs: [
        {
          id: "run_1",
          status: "FAILED",
          payload: { email: "someone@example.com", amount: 42 },
          output: "the receipt body",
          error: { name: "TimeoutError", message: "Stripe timed out" },
        },
      ],
      rows: [{ a: 1 }, { a: 2 }],
    }) as Record<string, any>;

    // The facts the judge grades on survive.
    expect(redacted.runs[0].id).toBe("run_1");
    expect(redacted.runs[0].status).toBe("FAILED");
    expect(redacted.runs[0].error.name).toBe("TimeoutError");
    expect(redacted.runs[0].error.message).toEqual({ redacted: "message", chars: 16 });
    // The customer's data does not.
    expect(redacted.runs[0].payload).toEqual({ redacted: "payload", keyCount: 2 });
    expect(redacted.runs[0].output).toEqual({ redacted: "output", chars: 16 });
    expect(redacted.rows).toEqual({ redacted: "rows", items: 2 });
    expect(JSON.stringify(redacted)).not.toContain("someone@example.com");
  });

  it("never lets a sensitive field through below the depth limit", () => {
    // `payload` sits nine levels down, past MAX_REDACT_DEPTH. The walk stops before it,
    // so what it carries must never reach the judge.
    let deep: Record<string, unknown> = { payload: { email: "someone@example.com" } };
    for (let i = 0; i < 9; i++) deep = { level: deep };

    const serialized = JSON.stringify(redactEvalToolValue(deep));
    expect(serialized).not.toContain("someone@example.com");
    expect(serialized).toContain('"truncated":true');
  });

  it("describes the shape at the depth limit instead of returning the value", () => {
    let deepObject: Record<string, unknown> = { rows: [{ a: 1 }], status: "FAILED" };
    for (let i = 0; i < 8; i++) deepObject = { level: deepObject };
    expect(redactEvalToolValue(deepObject)).toMatchObject({
      level: {
        level: {
          level: {
            level: {
              level: {
                level: {
                  level: { level: { truncated: true, keyCount: 2 } },
                },
              },
            },
          },
        },
      },
    });

    let deepArray: unknown = [{ a: 1 }, { a: 2 }, { a: 3 }];
    for (let i = 0; i < 8; i++) deepArray = { level: deepArray };
    expect(JSON.stringify(redactEvalToolValue(deepArray))).toContain(
      '{"truncated":true,"items":3}'
    );
  });

  it("still passes a primitive at the depth limit through", () => {
    let deep: unknown = "FAILED";
    for (let i = 0; i < 8; i++) deep = { level: deep };
    expect(JSON.stringify(redactEvalToolValue(deep))).toContain('"level":"FAILED"');
  });

  it("keeps source out of the judge payload entirely", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "read_file",
            output: { type: "json", value: { content: "const secret = 1;\n".repeat(100) } },
          },
        ],
      },
    ] as Parameters<typeof extractToolActivity>[0];

    const activity = extractToolActivity(messages);
    expect(JSON.stringify(activity)).not.toContain("const secret");
  });
});

describe("per-turn eval sampling", () => {
  let harness: MockChatAgentHarness | undefined;
  const originalRate = process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    if (originalRate === undefined) {
      delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
    } else {
      process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = originalRate;
    }
  });

  async function turnAtRate(rate: string, chatId: string): Promise<unknown[]> {
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = rate;
    const { store } = fakeStore();
    const { trigger, calls } = fakeEvalTrigger();
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("answered")]));
        set(dashboardAgentEvalTriggerKey, trigger);
        set(dashboardAgentEvalPolicyKey, fakeEvalPolicy());
      },
    });

    await harness.sendMessage(userMessage("hi"));
    // onTurnComplete enqueues after the turn-complete chunk, so give it a tick.
    await new Promise((r) => setTimeout(r, 30));
    return calls;
  }

  it("does not enqueue the eval task at rate 0", async () => {
    expect(await turnAtRate("0", "chat_rate_zero")).toHaveLength(0);
  });

  it("enqueues the eval task at rate 1", async () => {
    const calls = (await turnAtRate("1", "chat_rate_one")) as Array<{
      options: { idempotencyKey: string };
    }>;
    expect(calls).toHaveLength(1);
    // The key is chat + turn, so a retried turn is scored once.
    expect(calls[0]?.options.idempotencyKey).toBe("eval:chat_rate_one:0");
  });

  it("defaults to a tenth of turns when the rate is unset", () => {
    delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
    expect(evalSampleRate()).toBe(DEFAULT_EVAL_SAMPLE_RATE);
    expect(DEFAULT_EVAL_SAMPLE_RATE).toBe(0.1);
  });

  it("falls back to the default rate when the value is unparseable or out of range", () => {
    for (const raw of ["not-a-number", "", "  ", "-1", "2"]) {
      process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = raw;
      expect(evalSampleRate()).toBe(DEFAULT_EVAL_SAMPLE_RATE);
    }
  });

  it("honours a parseable rate", () => {
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = "0.5";
    expect(evalSampleRate()).toBe(0.5);
  });
});

describe("the CI sample rate", () => {
  const original = {
    context: process.env.DASHBOARD_AGENT_EVAL_CONTEXT,
    ci: process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI,
    production: process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE,
  };

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  afterEach(() => {
    restore("DASHBOARD_AGENT_EVAL_CONTEXT", original.context);
    restore("DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI", original.ci);
    restore("DASHBOARD_AGENT_EVAL_SAMPLE_RATE", original.production);
  });

  it("judges every turn in the CI lane", () => {
    process.env.DASHBOARD_AGENT_EVAL_CONTEXT = "ci";
    delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI;
    expect(isCiEvalContext()).toBe(true);
    expect(evalSampleRate()).toBe(DEFAULT_CI_EVAL_SAMPLE_RATE);
    expect(DEFAULT_CI_EVAL_SAMPLE_RATE).toBe(1);
  });

  it("does not let the CI rate reach production", () => {
    delete process.env.DASHBOARD_AGENT_EVAL_CONTEXT;
    delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI = "1";
    expect(isCiEvalContext()).toBe(false);
    expect(evalSampleRate()).toBe(DEFAULT_EVAL_SAMPLE_RATE);
  });

  it("does not let the production rate de-sample CI", () => {
    process.env.DASHBOARD_AGENT_EVAL_CONTEXT = "ci";
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = "0";
    delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI;
    expect(evalSampleRate()).toBe(1);
  });

  it("honours a parseable CI rate, and falls back to full on a bad one", () => {
    process.env.DASHBOARD_AGENT_EVAL_CONTEXT = "ci";
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI = "0.25";
    expect(evalSampleRate()).toBe(0.25);
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI = "nope";
    expect(evalSampleRate()).toBe(DEFAULT_CI_EVAL_SAMPLE_RATE);
  });

  it("only the exact context value selects the CI lane", () => {
    for (const raw of ["CI", "true", "1", "golden", ""]) {
      process.env.DASHBOARD_AGENT_EVAL_CONTEXT = raw;
      expect(isCiEvalContext()).toBe(false);
    }
  });
});

describe("the per-org opt-out", () => {
  let harness: MockChatAgentHarness | undefined;
  const originalRate = process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    if (originalRate === undefined) {
      delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
    } else {
      process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = originalRate;
    }
  });

  /** One turn at full sample rate, with the given opt-out check. */
  async function turnWithPolicy(
    policy: DashboardAgentEvalPolicyCheck,
    chatId: string
  ): Promise<unknown[]> {
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = "1";
    const { store } = fakeStore();
    const { trigger, calls } = fakeEvalTrigger();
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, mockModel([textStep("answered")]));
        set(dashboardAgentEvalTriggerKey, trigger);
        set(dashboardAgentEvalPolicyKey, policy);
      },
    });

    await harness.sendMessage(userMessage("hi"));
    await new Promise((r) => setTimeout(r, 30));
    return calls;
  }

  it("does not judge a turn when the org has opted out", async () => {
    expect(await turnWithPolicy(fakeEvalPolicy(false), "chat_opted_out")).toHaveLength(0);
  });

  it("does not judge a turn when the check itself fails", async () => {
    const throwing: DashboardAgentEvalPolicyCheck = async () => {
      throw new Error("the API is down");
    };
    expect(await turnWithPolicy(throwing, "chat_policy_error")).toHaveLength(0);
  });

  it("judges the turn when the org allows it", async () => {
    expect(await turnWithPolicy(fakeEvalPolicy(true), "chat_opted_in")).toHaveLength(1);
  });
});

describe("orgAllowsTurnEvals", () => {
  const ORG = { organizationId: "org_1", apiOrigin: "https://app.test", userActorToken: "uat_1" };

  it("allows only an explicit yes", async () => {
    const allowed = await orgAllowsTurnEvals({
      ...ORG,
      fetchImpl: async () => new Response(JSON.stringify({ turnEvalsEnabled: true })),
    });
    expect(allowed).toBe(true);
  });

  it("fails closed on a no, an unreadable body, a non-200 and a thrown request", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ turnEvalsEnabled: false })),
      // A string "true" is not a yes: only the boolean counts.
      async () => new Response(JSON.stringify({ turnEvalsEnabled: "true" })),
      async () => new Response(JSON.stringify({})),
      async () => new Response("not json"),
      async () => new Response("", { status: 500 }),
      async () => new Response("", { status: 403 }),
      async () => {
        throw new Error("network down");
      },
    ];

    for (const fetchImpl of responses) {
      expect(await orgAllowsTurnEvals({ ...ORG, fetchImpl })).toBe(false);
    }
  });

  it("fails closed when there is nothing to ask with", async () => {
    const neverCalled = async () => {
      throw new Error("must not be called");
    };
    expect(
      await orgAllowsTurnEvals({
        organizationId: "org_1",
        apiOrigin: undefined,
        userActorToken: "uat_1",
        fetchImpl: neverCalled,
      })
    ).toBe(false);
    expect(
      await orgAllowsTurnEvals({
        organizationId: "org_1",
        apiOrigin: "https://app.test",
        userActorToken: undefined,
        fetchImpl: neverCalled,
      })
    ).toBe(false);
  });
});

describe("a turn that read source", () => {
  let harness: MockChatAgentHarness | undefined;
  const originalRate = process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    if (originalRate === undefined) {
      delete process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
    } else {
      process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = originalRate;
    }
  });

  /** Runs one turn that calls `toolName`, at full sample rate, and returns the eval calls. */
  async function turnCalling(toolName: string, chatId: string): Promise<unknown[]> {
    process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE = "1";
    const { store } = fakeStore();
    const { trigger, calls } = fakeEvalTrigger();
    harness = mockChatAgent(dashboardAgent, {
      chatId,
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentToolsKey, {
          [toolName]: tool({
            description: "test double",
            inputSchema: z.object({ path: z.string().optional() }),
            execute: async () => ({ content: "const secret = 1;" }),
          }),
        });
        set(
          dashboardAgentModelKey,
          mockModel([toolCallStep(toolName, { path: "src/a.ts" }), textStep("answered")])
        );
        set(dashboardAgentEvalTriggerKey, trigger);
        set(dashboardAgentEvalPolicyKey, fakeEvalPolicy());
      },
    });

    await harness.sendMessage(userMessage("why does this fail?"));
    // onTurnComplete enqueues after the turn-complete chunk, so give it a tick.
    await new Promise((r) => setTimeout(r, 30));
    return calls;
  }

  it("is never judged, even at full sample rate", async () => {
    expect(await turnCalling("read_file", "chat_source_read")).toHaveLength(0);
  });

  it("still judges a turn that only read platform data", async () => {
    expect(await turnCalling("list_errors", "chat_no_source")).toHaveLength(1);
  });
});

describe("a turn that ends in an error", () => {
  let harness: MockChatAgentHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /**
   * A store that keeps the transcript the way the real one does: one row per message id,
   * kept in the order the ids were first seen, and a repeat updates that message in
   * place. Lets the test read history back rather than only count calls.
   */
  function transcriptStore(): { store: DashboardAgentStore; history: () => UIMessage[] } {
    const rows = new Map<string, UIMessage>();
    const record = (incoming: unknown[]) => {
      for (const message of incoming as UIMessage[]) rows.set(message.id, message);
    };
    const store: DashboardAgentStore = {
      ensureChat: async () => undefined,
      persistMessages: async (args) => record(args.messages),
      appendMessage: async (args) => {
        const message = args.message as UIMessage;
        if (!rows.has(message.id)) rows.set(message.id, message);
      },
      persistTurn: async (args) => {
        record(args.messages);
        return { settled: [] };
      },
      setChatTitleIfDefault: async () => undefined,
      upsertInvestigationRevision: async () => ({
        ok: true,
        id: "inv_fake",
        revision: 0,
        created: true,
      }),
      settleInvestigationCard: async (args) => ({
        ok: true,
        id: args.id,
        revision: 1,
        card: { id: args.messageId, role: "assistant", parts: [] },
        closed: true,
      }),
      seedInvestigation: async (args) => ({ ok: true, id: args.id, created: true }),
    };
    return { store, history: () => [...rows.values()] };
  }

  /** A model that fails the turn, the way a provider outage does. */
  function failingModel() {
    return new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("upstream_connect_error: provider said no");
      },
      doGenerate: async () => {
        throw new Error("upstream_connect_error: provider said no");
      },
    });
  }

  it("records the failure in the transcript, in the user's words", async () => {
    const { store, history } = transcriptStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_turn_error",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentModelKey, failingModel());
      },
    });

    const turn = await harness.sendMessage(userMessage("hi"));

    // The live chunk says the same sentence the transcript keeps, so the browser
    // and a reload never disagree, and the provider's words reach neither.
    const errorChunk = turn.chunks.find(
      (chunk) => (chunk as { type?: string }).type === "error"
    ) as { errorText?: string } | undefined;
    expect(errorChunk?.errorText).toBe(TURN_FAILED_MESSAGE);

    // onTurnComplete writes after the turn-complete chunk, so give it a tick.
    await new Promise((r) => setTimeout(r, 30));

    const stored = history();
    const failure = stored.find((message) => message.id === turnFailureMessageId(0));
    expect(failure?.role).toBe("assistant");
    expect(failure?.parts).toEqual([{ type: "text", text: TURN_FAILED_MESSAGE }]);
    // The record must never carry the provider's own words.
    expect(JSON.stringify(stored)).not.toContain("upstream_connect_error");
    // The user's question stays in the transcript next to it.
    expect(stored.some((message) => message.role === "user")).toBe(true);
  });

  /**
   * A tool's exception is handed to the same hook a stream failure is, so one failed
   * call used to mark the whole turn failed: the model worked around it, answered,
   * and the user still got "Something went wrong" under a finished answer — and the
   * model was told the turn was over instead of what to try next.
   */
  it("a failed tool call the model works around is not a failed turn", async () => {
    const { store, history } = transcriptStore();
    harness = mockChatAgent(dashboardAgent, {
      chatId: "chat_tool_error",
      clientData: CLIENT_DATA,
      setupLocals: ({ set }) => {
        set(dashboardAgentStoreKey, store);
        set(dashboardAgentToolsKey, {
          render_view: tool({
            description: "test double",
            inputSchema: z.object({ blocks: z.array(z.unknown()).optional() }),
            execute: async () => ({ blocks: [] }),
          }),
          offer_watch: tool({
            description: "test double that fails the way a tool bug does",
            inputSchema: z.object({ note: z.string().optional() }),
            execute: async (): Promise<{ ok: boolean }> => {
              throw new Error("Cannot read properties of undefined (reading 'fingerprint')");
            },
          }),
        });
        set(
          dashboardAgentModelKey,
          mockModel([
            toolCallStep("render_view", {}, "tc_verdict"),
            toolCallStep("offer_watch", {}, "tc_offer"),
            textStep("Rate limited — the retries all land in one window."),
          ])
        );
      },
    });

    const turn = await harness.sendMessage(userMessage("why is send-order-receipt failing?"));

    // The model is told what happened to that call, not that the turn is over.
    const toolError = turn.chunks.find(
      (chunk) => (chunk as { type?: string }).type === "tool-output-error"
    ) as { errorText?: string } | undefined;
    expect(toolError?.errorText).toBe(TOOL_FAILED_MESSAGE);
    expect(collectText(turn.chunks)).toBe("Rate limited — the retries all land in one window.");

    await new Promise((r) => setTimeout(r, 30));

    // And nothing tells the user the turn didn't finish, because it did.
    const stored = history();
    expect(stored.find((message) => message.id === turnFailureMessageId(0))).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(TURN_FAILED_MESSAGE);
    // The tool's own words never reach the transcript either.
    expect(JSON.stringify(stored)).not.toContain("fingerprint");
  });
});

// Back-compat: resumed chats replay their original metadata shape.
describe("clientDataSchema", () => {
  it("accepts the old shape a chat created before pageContext replays", () => {
    const parsed = clientDataSchema.safeParse({
      userId: "user_1",
      organizationId: "org_1",
      projectId: "proj_1",
      currentPage: "/orgs/acme/projects/p/env/dev/runs",
      apiOrigin: "http://localhost:3030",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts only the org + user pair", () => {
    expect(clientDataSchema.safeParse({ userId: "user_1", organizationId: "org_1" }).success).toBe(
      true
    );
  });

  it("accepts the new shape with environmentId and pageContext", () => {
    const parsed = clientDataSchema.safeParse({
      userId: "user_1",
      organizationId: "org_1",
      environmentId: "env_1",
      pageContext: {
        page: {
          kind: "run",
          runId: "run_1",
          status: "FAILED",
          taskId: "my-task",
          queue: "default",
        },
        signals: [
          { kind: "fresh_failure", runId: "run_1", failedAt: "2026-07-27T00:00:00.000Z" },
          { kind: "slow_run", runId: "run_2", durationMs: 9000, baselineP95Ms: 1200 },
          { kind: "concurrency_saturation", severity: "crit" },
        ],
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.pageContext?.signals).toHaveLength(3);
  });

  it("rejects a pageContext with an unknown page kind", () => {
    const parsed = clientDataSchema.safeParse({
      userId: "user_1",
      organizationId: "org_1",
      pageContext: { page: { kind: "nope" }, signals: [] },
    });
    expect(parsed.success).toBe(false);
  });

  // The snapshot URL is fetched and extracted on the worker, so the schema refuses
  // anything but plain https (the host allowlist is enforced at the fetch site).
  it("rejects a repoSnapshot whose tarballUrl is not an https URL", () => {
    for (const tarballUrl of [
      "http://codeload.github.com/acme/demo/tar.gz/abc",
      "ftp://example.com/x.tar.gz",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const parsed = clientDataSchema.safeParse({
        userId: "user_1",
        organizationId: "org_1",
        repoSnapshot: { tarballUrl, owner: "acme", repo: "demo", sha: "c".repeat(40) },
      });
      expect(parsed.success).toBe(false);
    }

    const ok = clientDataSchema.safeParse({
      userId: "user_1",
      organizationId: "org_1",
      repoSnapshot: {
        tarballUrl: "https://codeload.github.com/acme/demo/tar.gz/abc",
        owner: "acme",
        repo: "demo",
        sha: "c".repeat(40),
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe("buildDashboardAgentTools", () => {
  it("exposes the read tools plus render_view, and the data tools fail closed with no token", async () => {
    const tools = buildDashboardAgentTools({});
    expect(Object.keys(tools).sort()).toEqual(
      [
        "ask_support",
        "correlate_version",
        "create_alert",
        "delete_alert",
        "get_current_page",
        "get_deploy",
        "get_error",
        "get_query_schema",
        "get_queue",
        "get_report",
        "get_run",
        "get_run_trace",
        "list_alerts",
        "list_deploys",
        "list_environments",
        "list_errors",
        "list_projects",
        "list_runs",
        "list_tasks",
        "navigate_to",
        "run_query",
        "render_view",
        "schedule_watch",
        "search_docs",
      ].sort()
    );

    // With no token every data tool returns an error, never throws and never hits the
    // network. The exempt ones read no user data: render_view and navigate_to validate
    // a spec, get_current_page reads the turn's own context, and ask_support and
    // search_docs are public knowledge lanes gated on their own config.
    const EXEMPT = ["render_view", "ask_support", "search_docs", "get_current_page"];
    for (const name of Object.keys(tools)) {
      if (EXEMPT.includes(name)) continue;
      const tool = tools[name] as { execute?: (input: unknown, opts: unknown) => Promise<unknown> };
      const result = (await tool.execute?.({}, {})) as { error?: string };
      expect(result).toHaveProperty("error");
      expect(typeof result.error).toBe("string");
    }
  });

  it("render_view echoes a validated view spec back as its output", async () => {
    const tools = buildDashboardAgentTools({});
    const renderView = tools.render_view as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>;
    };
    const spec = {
      blocks: [
        {
          type: "diagnosis",
          runId: "run_abc123",
          summary: "The task threw because the order had no line items.",
          category: "user_code_error",
          likelyCause: "processOrder throws when items is empty.",
          confidence: "high",
          evidence: [
            { type: "error", detail: "Error: order has no items", reference: "run_abc123" },
          ],
          nextSteps: ["Validate the payload before triggering."],
        },
      ],
    };
    const output = await renderView.execute(spec, {});
    expect(output).toEqual(spec);
  });

  const SCOPE = { projectRef: "proj_abc", environmentId: "env_abc" };
  const callTool = (name: string, input: unknown, ctx: Record<string, unknown> = SCOPE) => {
    const tools = buildDashboardAgentTools(ctx);
    const tool = tools[name] as { execute: (input: unknown, opts: unknown) => Promise<any> };
    return tool.execute(input, {});
  };

  it("navigate_to emits a trigger:// navigate intent for each addressable kind", async () => {
    await expect(
      callTool("navigate_to", { destination: { kind: "run", runId: "run_1" } })
    ).resolves.toEqual({
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/run/run_1" },
    });

    await expect(
      callTool("navigate_to", { destination: { kind: "error", fingerprint: "error_1" } })
    ).resolves.toEqual({
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/error/1" },
    });

    // A queue name's `/` is percent-encoded, so a task queue round-trips.
    await expect(
      callTool("navigate_to", { destination: { kind: "queue", name: "task/send-receipt" } })
    ).resolves.toEqual({
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/queue/task%2Fsend-receipt" },
    });

    await expect(
      callTool("navigate_to", { destination: { kind: "deployment", version: "20260101.1" } })
    ).resolves.toEqual({
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/deployment/20260101.1" },
    });
  });

  it("navigate_to carries runs-list filters and never emits a dashboard path", async () => {
    const filters = { tasks: ["send-receipt"], statuses: ["FAILED"], period: "1d" };
    const result = await callTool("navigate_to", { destination: { kind: "runs", filters } });
    expect(result.intent).toEqual({
      kind: "navigate",
      target: "trigger://proj_abc/env_abc/runs",
      filters,
    });
    expect(result.appliedFilters).toEqual(filters);
    expect(JSON.stringify(result)).not.toContain("/orgs/");
  });

  it("navigate_to fails closed when the turn has no project or environment", async () => {
    const result = await callTool(
      "navigate_to",
      { destination: { kind: "run", runId: "run_1" } },
      {}
    );
    expect(typeof result.error).toBe("string");
  });

  // Behaves like the real query: no id creates at revision 0, an id bumps the
  // revision, and a foreign id reports a context mismatch without writing.
  function fakeInvestigations(overrides: { mismatch?: boolean } = {}) {
    const rows = new Map<string, { revision: number; state: unknown }>();
    const upserts: Array<Record<string, unknown>> = [];
    let next = 1;
    return {
      rows,
      upserts,
      capability: {
        upsert: async (params: {
          id?: string;
          projectRef: string;
          environmentRef: string;
          state: unknown;
        }) => {
          upserts.push(params);
          if (overrides.mismatch) return { ok: false as const, error: "context_mismatch" as const };
          if (!params.id) {
            const id = `inv_fake${next++}`;
            rows.set(id, { revision: 0, state: params.state });
            return { ok: true as const, id, revision: 0, created: true };
          }
          const row = rows.get(params.id);
          if (!row) return { ok: false as const, error: "not_found" as const };
          row.revision += 1;
          row.state = params.state;
          return { ok: true as const, id: params.id, revision: row.revision, created: false };
        },
      },
    };
  }

  const investigationState = {
    outcome: "in_progress",
    severity: "warn",
    confidence: "low",
    runId: "run_abc123",
    title: "Why is send-order-receipt failing?",
    headline: "All three attempts ended in an error from the email provider.",
    progress: "Reading the run's spans",
    hypotheses: [
      {
        id: "hyp_rate_limit",
        statement: "The provider is rate limiting this API key.",
        verdict: "testing",
        evidence: [],
      },
    ],
    evidence: [
      {
        kind: "run",
        uri: "trigger://proj_abc/env_abc/run/run_abc123",
        label: "run_abc123 · failed after 3 attempts",
      },
    ],
  };

  // Parsed through the tool's own inputSchema, the way the AI SDK does, so these tests
  // exercise the model-facing boundary and not a hand-built object.
  const renderInvestigation = async (
    tools: ReturnType<typeof buildDashboardAgentTools>,
    state: Record<string, unknown> = investigationState,
    investigationId?: string
  ) => {
    const renderView = tools.render_view as {
      inputSchema: { parse: (input: unknown) => unknown };
      execute: (input: unknown, opts: unknown) => Promise<any>;
    };
    const input = renderView.inputSchema.parse({
      blocks: [{ type: "investigation", investigation: state }],
      ...(investigationId ? { investigationId } : {}),
    });
    return renderView.execute(input, {});
  };

  const concludedState = {
    ...investigationState,
    outcome: "concluded",
    confidence: "high",
    remediation: "Raise minTimeoutInMs to 30s with a factor of 2.",
    hypotheses: [
      {
        ...investigationState.hypotheses[0]!,
        verdict: "validated",
        finding: "All three attempts returned 429 inside 20 seconds.",
      },
    ],
  };

  it("render_view assigns an investigation's identity on the first render", async () => {
    const { capability, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools);

    // Revision 0 committed with the turn's own project/environment, and the block that
    // reaches the transcript carries the identity the store assigned.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      id: undefined,
      projectRef: "proj_abc",
      environmentRef: "env_abc",
    });
    expect(output.investigationId).toBe("inv_fake1");
    expect(output.blocks[0]).toMatchObject({ id: "inv_fake1", revision: 0, version: 1 });
    expect(output.blocks[0].investigation.title).toBe(investigationState.title);
  });

  it("render_view canonicalizes bare evidence ids into trigger:// URIs", async () => {
    const { capability, upserts } = fakeInvestigations();
    // Span evidence must come from this turn's trace read, so exchange a real env token
    // and stub the trace call the same way the model would drive it.
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      if (url.endsWith("/runs/run_abc123/trace")) {
        return { body: { trace: { traceId: "t1", rootSpan: { id: "span_123", data: {} } } } };
      }
      return { body: {} };
    });
    try {
      const tools = buildDashboardAgentTools({ ...ENV_CTX, investigations: capability });
      await (tools.get_run_trace as { execute: (i: unknown, o: unknown) => Promise<any> }).execute(
        { runId: "run_abc123" },
        {}
      );

      const output = await renderInvestigation(tools, {
        ...investigationState,
        hypotheses: [
          {
            ...investigationState.hypotheses[0]!,
            evidence: [
              { kind: "error", uri: "error_c4b4a797397a9c43", label: "the error group" },
              { kind: "deployment", uri: "20260726.4", label: "the deploy before the failures" },
              // An improvised almost-URI: the bare id is salvaged from the last segment.
              {
                kind: "error",
                uri: "trigger://errors/error_c4b4a797397a9c43",
                label: "improvised",
              },
            ],
          },
        ],
        evidence: [
          // Already canonical, so it passes through untouched.
          ...investigationState.evidence,
          // A span carries its two parts, so the executor can build the URI — but only
          // because get_run_trace returned this exact id earlier in the turn.
          { kind: "span", runId: "run_abc123", spanId: "span_123", label: "the failing span" },
        ],
      });

      expect(output.error).toBeUndefined();
      const investigation = output.blocks[0].investigation;
      expect(investigation.hypotheses[0].evidence.map((e: { uri: string }) => e.uri)).toEqual([
        "trigger://proj_abc/env_abc/error/c4b4a797397a9c43",
        "trigger://proj_abc/env_abc/deployment/20260726.4",
        "trigger://proj_abc/env_abc/error/c4b4a797397a9c43",
      ]);
      expect(investigation.evidence.map((e: { uri: string }) => e.uri)).toEqual([
        "trigger://proj_abc/env_abc/run/run_abc123",
        "trigger://proj_abc/env_abc/run/run_abc123/span/span_123",
      ]);
      expect(JSON.stringify(upserts[0])).not.toContain('"uri":"error_c4b4a797397a9c43"');
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view rejects a span id no trace read returned this turn", async () => {
    const { capability, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        ...investigationState.evidence,
        // get_run_trace was never called this turn, so this id is unproven.
        { kind: "span", runId: "run_abc123", spanId: "span_999", label: "an invented span" },
      ],
    });

    expect(output.blocks).toBeUndefined();
    expect(output.error).toContain("span_999");
    expect(output.error).toContain("get_run_trace");
    expect(upserts).toHaveLength(0);
  });

  it("render_view pins a source citation to the commit the file was read at", async () => {
    await seedWorkspace();
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });
    await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {});

    const output = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        {
          kind: "source",
          path: "src/tasks/send-order-receipt.ts",
          line: 42,
          label: "the retry config",
        },
        // The same commit, named explicitly: the read proves it, so it's accepted.
        {
          kind: "source",
          path: "src/tasks/send-order-receipt.ts",
          sha: codeSnapshot.sha,
          label: "the whole file",
        },
      ],
    });

    expect(output.error).toBeUndefined();
    expect(output.blocks[0].investigation.evidence.map((e: { uri: string }) => e.uri)).toEqual([
      `trigger://proj_abc/env_abc/source/${codeSnapshot.sha}/src/tasks/send-order-receipt.ts?line=42`,
      `trigger://proj_abc/env_abc/source/${codeSnapshot.sha}/src/tasks/send-order-receipt.ts`,
    ]);
  });

  it("render_view fails by name when a cited file was never read, rather than borrowing the snapshot's commit", async () => {
    const { capability, upserts } = fakeInvestigations();
    // A snapshot is in scope; it just isn't proof that anything was opened.
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });

    const output = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [{ kind: "source", path: "src/a.ts", line: 3, label: "the line that throws" }],
    });

    expect(output.blocks).toBeUndefined();
    expect(output.error).toContain("src/a.ts");
    expect(output.error).toContain("read");
    expect(output.error).not.toContain(codeSnapshot.sha);
    expect(upserts).toHaveLength(0);
  });

  it("render_view rejects a model-supplied commit no read backs", async () => {
    await seedWorkspace();
    const { capability, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });
    // Read at the snapshot's commit, then cite a different one.
    await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {});

    const output = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        {
          kind: "source",
          path: "src/tasks/send-order-receipt.ts",
          line: 1,
          sha: "b".repeat(40),
          label: "the retry config",
        },
      ],
    });

    expect(output.blocks).toBeUndefined();
    expect(output.error).toContain("src/tasks/send-order-receipt.ts");
    expect(output.error).toContain("b".repeat(7));
    expect(upserts).toHaveLength(0);
  });

  const codeSnapshot: RepoSnapshot = {
    tarballUrl: "http://unused.invalid/never-fetched",
    owner: "acme",
    repo: "orders",
    sha: "c".repeat(40),
  };

  // Pre-seed the deterministic workspace with a `.ready` marker so read_file serves it
  // offline, the same way repo-tools.test.ts does.
  const seedWorkspace = async () => {
    const dir = workdirFor(codeSnapshot);
    await mkdir(join(dir, "src/tasks"), { recursive: true });
    await writeFile(
      join(dir, "src/tasks/send-order-receipt.ts"),
      "export const retry = { maxAttempts: 3, minTimeoutInMs: 1000 };\n"
    );
    await writeFile(join(dir, ".ready"), codeSnapshot.sha);
  };

  const readFileTool = (tools: ReturnType<typeof buildDashboardAgentTools>) =>
    tools.read_file as { execute: (input: unknown, opts: unknown) => Promise<any> };

  const concludedWithSource = {
    ...concludedState,
    evidence: [
      { kind: "error", uri: "error_c4b4a797397a9c43", label: "the error group" },
      {
        kind: "source",
        path: "src/tasks/send-order-receipt.ts",
        line: 1,
        label: "the retry config",
      },
    ],
  };

  afterEach(async () => {
    await disposeRepoWorkspaces();
  });

  it("offers Show code only once the cited file was really read at the pinned commit", async () => {
    await seedWorkspace();
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });

    // Cited but never read: the render fails on the citation, so there is no card to
    // hang a button on.
    const unread = await renderInvestigation(tools, concludedWithSource);
    expect(unread.blocks).toBeUndefined();
    expect(unread.error).toContain("src/tasks/send-order-receipt.ts");

    // Read it, and the same state earns the button, grounded in the canonical source
    // URI as a canned ask the model didn't write.
    expect(
      (await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {})).content
    ).toContain("maxAttempts");

    const grounded = await renderInvestigation(tools, concludedWithSource);
    const actions = grounded.blocks[0].capabilities.actions;
    expect(actions.map((a: { kind: string }) => a.kind)).toEqual([
      "show_code",
      "watch_recurrence",
      "view_similar",
    ]);
    expect(actions[0].intent.kind).toBe("ask");
    // The ask proposes a change rather than another explanation.
    const prompt: string = actions[0].intent.prompt;
    expect(prompt).toContain("```diff");
    expect(prompt).toContain(`src/tasks/send-order-receipt.ts:1@${codeSnapshot.sha.slice(0, 7)}`);
    expect(prompt).toMatch(/minimal change/i);
    expect(prompt).toMatch(/dirty tree|branch head/i);
    expect(prompt).toMatch(/don't restate the investigation/i);

    // "Watch for a repeat" carries the kind and the subject, so the Watch card is
    // pre-filled without another model turn.
    expect(actions[1].intent).toEqual({
      kind: "watch",
      spec: {
        kind: "error_recurrence",
        fingerprint: "c4b4a797397a9c43",
        checkEveryMinutes: 15,
        maxHours: 24,
        note: `A repeat of: ${concludedWithSource.title}`,
      },
    });

    expect(actions[2].intent).toEqual({
      kind: "navigate",
      target: "trigger://proj_abc/env_abc/error/c4b4a797397a9c43",
    });
  });

  // A concluded card citing no error group has no subject to pre-fill from, so the
  // button is left off rather than offered empty.
  it("offers no repeat watch when the card cites no error group", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools, concludedState);
    const kinds = (output.blocks[0].capabilities?.actions ?? []).map(
      (a: { kind: string }) => a.kind
    );
    expect(kinds).not.toContain("watch_recurrence");
  });

  it("offers no actions while an investigation is still in progress", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });
    const output = await renderInvestigation(tools);
    expect(output.blocks[0].capabilities).toBeUndefined();
  });

  // An inconclusive card has no cause to watch for a repeat of, so the handoff stays
  // off it.
  it("offers a keep-digging follow-up, and never Show code or a repeat watch, on an inconclusive card", async () => {
    await seedWorkspace();
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({
      ...SCOPE,
      investigations: capability,
      repoSnapshot: codeSnapshot,
    });
    await readFileTool(tools).execute({ path: "src/tasks/send-order-receipt.ts" }, {});

    const output = await renderInvestigation(tools, {
      ...concludedWithSource,
      outcome: "inconclusive",
      remediation: undefined,
      checkNext: ["Add a span around the provider call."],
    });
    expect(output.blocks[0].capabilities.actions.map((a: { kind: string }) => a.kind)).toEqual([
      "ask_follow_up",
      "view_similar",
    ]);
  });

  it("render_view validates an already-full URI instead of trusting it", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    // Right shape, wrong kind.
    const wrongKind = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        { kind: "error", uri: "trigger://proj_abc/env_abc/run/run_abc123", label: "mislabelled" },
      ],
    });
    expect(wrongKind.error).toContain("cites a run URI");

    // Right shape, another tenant.
    const wrongScope = await renderInvestigation(tools, {
      ...investigationState,
      evidence: [
        { kind: "run", uri: "trigger://proj_other/env_other/run/run_abc123", label: "borrowed" },
      ],
    });
    expect(wrongScope.error).toContain("different project or environment");
  });

  it("render_view revises the same investigation on the next render", async () => {
    const { capability, rows } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const first = await renderInvestigation(tools);
    const second = await renderInvestigation(tools, concludedState);

    // One investigation, two revisions, so the panel shows one live card.
    expect(rows.size).toBe(1);
    expect(second.investigationId).toBe(first.investigationId);
    expect(second.blocks[0].revision).toBe(1);
    expect(second.blocks[0].investigation.remediation).toBeDefined();
  });

  // A later turn gets a fresh tool set, so the closure is empty and the model must
  // pass back the id the tool returned.
  it("render_view continues a previous turn's investigation from the returned id", async () => {
    const { capability, rows } = fakeInvestigations();

    const first = await renderInvestigation(
      buildDashboardAgentTools({ ...SCOPE, investigations: capability })
    );

    // Next turn: new tool set, same chat.
    const second = await renderInvestigation(
      buildDashboardAgentTools({ ...SCOPE, investigations: capability }),
      concludedState,
      first.investigationId
    );

    expect(rows.size).toBe(1);
    expect(second.investigationId).toBe(first.investigationId);
    expect(second.blocks[0].id).toBe(first.investigationId);
    expect(second.blocks[0].revision).toBe(1);
  });

  it("render_view keeps the turn's own investigation when the model passes a different id", async () => {
    const { capability, rows, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const first = await renderInvestigation(tools);
    const second = await renderInvestigation(tools, concludedState, "inv_somewhere_else");

    // The closure wins within a turn, so a mid-investigation redirect can't happen.
    expect(rows.size).toBe(1);
    expect(second.investigationId).toBe(first.investigationId);
    expect(upserts[1]).toMatchObject({ id: first.investigationId });
  });

  it("render_view refuses two investigations in one view and writes neither", async () => {
    const { capability, rows, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });
    const renderView = tools.render_view as {
      inputSchema: { parse: (input: unknown) => unknown };
      execute: (input: unknown, opts: unknown) => Promise<any>;
    };

    const output = await renderView.execute(
      renderView.inputSchema.parse({
        blocks: [
          { type: "investigation", investigation: investigationState },
          {
            type: "investigation",
            investigation: { ...concludedState, title: "A different question entirely" },
          },
        ],
      }),
      {}
    );

    // One id is assigned per call, so committing both would file the second subject as
    // the first's next revision.
    expect(typeof output.error).toBe("string");
    expect(output.blocks).toBeUndefined();
    expect(upserts).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it("render_view errors on an unknown investigationId and writes nothing", async () => {
    const { capability, rows } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools, investigationState, "inv_never_existed");

    expect(typeof output.error).toBe("string");
    expect(output.blocks).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it("render_view errors on an investigationId from another chat and writes nothing", async () => {
    // The store owns the chat/project/env check, so a foreign id comes back as a
    // mismatch whatever the model claims.
    const { capability, rows } = fakeInvestigations({ mismatch: true });
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools, investigationState, "inv_other_chat");

    expect(typeof output.error).toBe("string");
    expect(output.blocks).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it("render_view reports a context mismatch instead of overwriting", async () => {
    const { capability } = fakeInvestigations({ mismatch: true });
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const output = await renderInvestigation(tools);
    expect(typeof output.error).toBe("string");
    expect(output.blocks).toBeUndefined();
  });

  it("render_view fails closed when the turn can't scope an investigation", async () => {
    const { capability } = fakeInvestigations();
    // No store seam at all, and no project/environment.
    expect(typeof (await renderInvestigation(buildDashboardAgentTools({}))).error).toBe("string");
    expect(
      typeof (await renderInvestigation(buildDashboardAgentTools({ investigations: capability })))
        .error
    ).toBe("string");
  });

  it("render_view ignores an id the model tries to supply", async () => {
    const { capability, upserts } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });

    const renderView = tools.render_view as {
      inputSchema: { parse: (input: unknown) => unknown };
      execute: (input: unknown, opts: unknown) => Promise<any>;
    };
    const input = renderView.inputSchema.parse({
      blocks: [
        {
          type: "investigation",
          // Envelope fields on the block and identity inside the payload, all stripped
          // by the input schema.
          id: "inv_smuggled",
          revision: 42,
          version: 9,
          investigation: {
            ...investigationState,
            investigationId: "inv_smuggled",
            revision: 42,
          },
        },
      ],
    });
    const output = await renderView.execute(input, {});

    expect(output.blocks[0].id).toBe("inv_fake1");
    expect(output.blocks[0].revision).toBe(0);
    expect(output.blocks[0].version).toBe(1);
    expect(upserts[0]?.state).not.toHaveProperty("investigationId");
    expect(upserts[0]?.state).not.toHaveProperty("revision");
  });

  it("render_view still echoes a spec with no investigation in it", async () => {
    const { capability } = fakeInvestigations();
    const tools = buildDashboardAgentTools({ ...SCOPE, investigations: capability });
    const renderView = tools.render_view as {
      execute: (input: unknown, opts: unknown) => Promise<any>;
    };
    const chart = {
      type: "chart",
      query: "SELECT toStartOfHour(created_at) AS bucket, count() AS runs FROM runs",
      chartType: "line",
      xAxisColumn: "bucket",
      yAxisColumns: ["runs"],
    };
    await expect(renderView.execute({ blocks: [chart] }, {})).resolves.toEqual({ blocks: [chart] });
  });

  const WATCH_CTX = {
    userActorToken: "uat_token",
    apiOrigin: "http://localhost:3030",
    chatId: "chat_1",
  };

  const RUN_WATCH = {
    kind: "run_finished" as const,
    runId: "run_a1",
    checkEveryMinutes: 1 as const,
    maxHours: 2,
    note: "tell me when the receipt run finishes",
  };

  // Records any request schedule_watch would have made. It must make none: the card
  // the intent opens is the only thing that creates a watch.
  async function scheduleWatch(
    input: unknown = { watch: RUN_WATCH },
    ctx: Record<string, unknown> = WATCH_CTX
  ) {
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      requests.push(String(url));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const tools = buildDashboardAgentTools(ctx);
      const scheduleTool = tools.schedule_watch as {
        inputSchema: { parse: (input: unknown) => unknown };
        execute: (input: unknown, opts: unknown) => Promise<any>;
      };
      const result = await scheduleTool.execute(input, {});
      return { result, requests };
    } finally {
      globalThis.fetch = original;
    }
  }

  it("schedule_watch returns a watch intent and creates nothing", async () => {
    const { result, requests } = await scheduleWatch();

    expect(result).toEqual({ intent: { kind: "watch", spec: RUN_WATCH } });
    expect(requests).toEqual([]);
  });

  it("schedule_watch has no consent parameter — the card owns the opt-ins", () => {
    const tools = buildDashboardAgentTools(WATCH_CTX);
    const scheduleTool = tools.schedule_watch as {
      inputSchema: { parse: (input: unknown) => unknown };
    };
    const parsed = scheduleTool.inputSchema.parse({
      watch: RUN_WATCH,
      investigateOnAttention: true,
    });
    expect(parsed).toEqual({ watch: RUN_WATCH });
  });

  it("schedule_watch rejects a spec the contract won't accept", async () => {
    // Aggregate conditions are floored at 5 minutes by the contract's schema.
    const floored = await scheduleWatch({
      watch: {
        kind: "backlog_drain",
        queue: "task/x",
        checkEveryMinutes: 1,
        maxHours: 1,
        note: "n",
      },
    });
    expect(typeof floored.result.error).toBe("string");
    expect(floored.requests).toEqual([]);

    const nonsense = await scheduleWatch({ watch: { kind: "run_finished" } });
    expect(typeof nonsense.result.error).toBe("string");
  });

  // The env-JWT exchange is a webapp request plus DB work, so it is paid for once per
  // tool set, and so once per turn, however many env-scoped tools run.
  const ENV_CTX = {
    userActorToken: "uat_token",
    apiOrigin: "http://localhost:3030",
    projectRef: "proj_abc",
    environmentName: "prod",
    environmentId: "env_abc",
  };

  // Records every request path, so a test can count exchanges (`/jwt`) separately from
  // the data reads.
  function stubFetch(
    respond: (url: string, init: RequestInit | undefined) => { status?: number; body: unknown }
  ) {
    const requests: Array<{ url: string; token?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url: String(url), token: headers.Authorization });
      const { status, body } = respond(String(url), init);
      return new Response(JSON.stringify(body ?? {}), {
        status: status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return {
      requests,
      exchanges: () => requests.filter((r) => r.url.endsWith("/jwt")).length,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  }

  it("exchanges the env JWT once per tool set, however many env-scoped tools call the API", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      return { body: { data: [], results: [], trace: { traceId: "t1" } } };
    });
    try {
      const tools = buildDashboardAgentTools(ENV_CTX);
      const call = (name: string, input: unknown) =>
        (tools[name] as { execute: (i: unknown, o: unknown) => Promise<any> }).execute(input, {});

      await call("get_run", { runId: "run_1" });
      await call("list_runs", {});
      await call("list_errors", {});
      await call("get_run_trace", { runId: "run_1" });
      await call("get_report", {});
      await call("run_query", { query: "select 1" });

      expect(fetchStub.exchanges()).toBe(1);
      // Six data reads, all carrying the one exchanged token.
      const reads = fetchStub.requests.filter((r) => !r.url.endsWith("/jwt"));
      expect(reads).toHaveLength(6);
      expect(reads.every((r) => r.token === "Bearer jwt_1")).toBe(true);

      // Concurrent calls share the one in-flight exchange too.
      const parallel = buildDashboardAgentTools(ENV_CTX);
      const parallelCall = (name: string, input: unknown) =>
        (parallel[name] as { execute: (i: unknown, o: unknown) => Promise<any> }).execute(
          input,
          {}
        );
      const before = fetchStub.exchanges();
      await Promise.all([
        parallelCall("get_run", { runId: "run_1" }),
        parallelCall("list_runs", {}),
        parallelCall("list_errors", {}),
      ]);
      // A fresh tool set is a fresh turn, so exactly one more.
      expect(fetchStub.exchanges()).toBe(before + 1);
    } finally {
      fetchStub.restore();
    }
  });

  it("re-exchanges once and retries when the cached env JWT is rejected", async () => {
    let minted = 0;
    const fetchStub = stubFetch((url, init) => {
      if (url.endsWith("/jwt")) return { body: { token: `jwt_${++minted}` } };
      const token = (init?.headers as Record<string, string> | undefined)?.Authorization;
      // The first token is stale (minted at its expiry edge); the second works.
      if (token === "Bearer jwt_1") return { status: 401, body: {} };
      return { body: { id: "run_1", status: "COMPLETED" } };
    });
    try {
      const tools = buildDashboardAgentTools(ENV_CTX);
      const getRun = tools.get_run as { execute: (i: unknown, o: unknown) => Promise<any> };

      await expect(getRun.execute({ runId: "run_1" }, {})).resolves.toMatchObject({
        id: "run_1",
        status: "COMPLETED",
      });
      expect(fetchStub.exchanges()).toBe(2);
      expect(fetchStub.requests.map((r) => r.token)).toEqual([
        "Bearer uat_token",
        "Bearer jwt_1",
        "Bearer uat_token",
        "Bearer jwt_2",
      ]);

      // The refreshed token is now the cached one, so the next call pays nothing.
      await getRun.execute({ runId: "run_2" }, {});
      expect(fetchStub.exchanges()).toBe(2);
    } finally {
      fetchStub.restore();
    }
  });

  it("retries an unauthorized env call only once, then reports the failure", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_x" } };
      return { status: 401, body: {} };
    });
    try {
      const tools = buildDashboardAgentTools(ENV_CTX);
      const result = await (
        tools.list_runs as { execute: (i: unknown, o: unknown) => Promise<any> }
      ).execute({}, {});
      expect(result.error).toContain("401");
      // One retry, not a loop: two exchanges and two reads.
      expect(fetchStub.exchanges()).toBe(2);
      expect(fetchStub.requests).toHaveLength(4);
    } finally {
      fetchStub.restore();
    }
  });

  const CHART_SPEC = {
    blocks: [
      {
        type: "chart",
        title: "Runs per hour",
        query: "SELECT toStartOfHour(triggered_at) AS bucket, count() AS runs FROM runs",
        period: "24h",
        chartType: "line" as const,
        xAxisColumn: "bucket",
        yAxisColumns: ["runs"],
      },
    ],
  };

  const renderView = (ctx: Record<string, unknown>, spec: unknown) =>
    (
      buildDashboardAgentTools(ctx).render_view as {
        execute: (i: unknown, o: unknown) => Promise<any>;
      }
    ).execute(spec, {});

  const queryRequests = (requests: Array<{ url: string }>) =>
    requests.filter((r) => r.url.endsWith("/api/v1/query"));

  it("render_view fails with the chart query's own error, committing no blocks", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      return { status: 400, body: { error: "Unknown column createdAt" } };
    });
    try {
      const result = await renderView(ENV_CTX, {
        blocks: [{ ...CHART_SPEC.blocks[0], query: "SELECT createdAt FROM runs" }],
      });
      expect(result.error).toContain("Unknown column createdAt");
      expect(result.blocks).toBeUndefined();
      expect(queryRequests(fetchStub.requests)).toHaveLength(1);
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view commits the chart when its query runs, validating it once", async () => {
    // Collected, never asserted here: render_view swallows a throw out of the stub, as
    // the sibling test below relies on.
    const queryBodies: unknown[] = [];
    const fetchStub = stubFetch((url, init) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      queryBodies.push(JSON.parse(String(init?.body)));
      return { body: { results: [{ bucket: "2026-01-01T00:00:00Z", runs: 1 }] } };
    });
    try {
      // The rows aren't embedded in the block — the panel stays the runner.
      await expect(renderView(ENV_CTX, CHART_SPEC)).resolves.toEqual({ blocks: CHART_SPEC.blocks });
      expect(queryRequests(fetchStub.requests)).toHaveLength(1);
      // The validation runs the same window the panel will render.
      expect(queryBodies).toHaveLength(1);
      expect(queryBodies[0]).toMatchObject({ scope: "environment", period: "24h" });
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view commits the chart when the validation request itself fails", async () => {
    const fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) return { body: { token: "jwt_1" } };
      throw new Error("ECONNREFUSED");
    });
    try {
      await expect(renderView(ENV_CTX, CHART_SPEC)).resolves.toEqual({ blocks: CHART_SPEC.blocks });
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view skips chart validation when the turn carries no delegated token", async () => {
    const fetchStub = stubFetch(() => ({ status: 400, body: { error: "never asked" } }));
    try {
      await expect(renderView({}, CHART_SPEC)).resolves.toEqual({ blocks: CHART_SPEC.blocks });
      expect(fetchStub.requests).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  it("render_view never runs a query for non-chart blocks", async () => {
    const fetchStub = stubFetch(() => ({ status: 400, body: { error: "never asked" } }));
    try {
      const blocks = [
        {
          type: "diagnosis",
          runId: "run_abc123",
          summary: "The task threw because the order had no line items.",
          category: "user_code_error",
          likelyCause: "processOrder throws when items is empty.",
          confidence: "high",
          evidence: [{ type: "error", detail: "Error: order has no items" }],
          nextSteps: ["Validate the payload before triggering."],
        },
      ];
      await expect(renderView(ENV_CTX, { blocks })).resolves.toEqual({ blocks });
      expect(fetchStub.requests).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  it("get_current_page returns the turn's structured page context", async () => {
    const pageContext = {
      page: { kind: "run" as const, runId: "run_1", status: "FAILED", taskId: "send-receipt" },
      signals: [
        { kind: "fresh_failure" as const, runId: "run_1", failedAt: "2026-01-01T00:00:00Z" },
        {
          kind: "concurrency_saturation" as const,
          severity: "crit" as const,
          scope: "queue" as const,
          queueName: "black-friday",
          limit: 10,
          current: 12,
        },
      ],
    };
    await expect(
      callTool("get_current_page", {}, { ...SCOPE, pageContext, currentPage: "/runs/run_1" })
    ).resolves.toEqual({
      page: pageContext.page,
      signals: pageContext.signals,
      path: "/runs/run_1",
    });

    // Only a raw path degrades to the `other` page kind.
    await expect(callTool("get_current_page", {}, { currentPage: "/some/page" })).resolves.toEqual({
      page: { kind: "other", path: "/some/page" },
      signals: [],
    });

    // Nothing at all: say so rather than guessing.
    const blind = await callTool("get_current_page", {}, {});
    expect(blind.page).toBeNull();
    expect(typeof blind.note).toBe("string");
  });

  // The tools are rebuilt from the turn's clientData, so a stale answer can only come
  // from the model reusing an earlier turn instead of calling again.
  it("get_current_page follows the user between turns", async () => {
    const first = await callTool(
      "get_current_page",
      {},
      { ...SCOPE, pageContext: { page: { kind: "queue" as const, name: "email" }, signals: [] } }
    );
    const second = await callTool(
      "get_current_page",
      {},
      {
        ...SCOPE,
        pageContext: { page: { kind: "run" as const, runId: "run_2" }, signals: [] },
      }
    );

    expect(first.page).toEqual({ kind: "queue", name: "email" });
    expect(second.page).toEqual({ kind: "run", runId: "run_2" });
  });
});

describe("watch alert tools", () => {
  const ALERT_CTX = {
    userActorToken: "uat_token",
    apiOrigin: "http://localhost:3030",
    projectRef: "proj_abc",
    environmentName: "prod",
    chatId: "chat_alerts",
  };

  // Hands back the tool's result and the request the webapp would have received.
  async function callAlertTool(
    name: string,
    input: unknown,
    response: { status?: number; body: unknown },
    ctx: Record<string, unknown> = ALERT_CTX
  ) {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const tools = buildDashboardAgentTools(ctx);
      const tool = tools[name] as {
        inputSchema: { parse: (input: unknown) => unknown };
        execute: (input: unknown, opts: unknown) => Promise<any>;
      };
      const result = await tool.execute(tool.inputSchema.parse(input), {});
      return { result, requests };
    } finally {
      globalThis.fetch = original;
    }
  }

  it("list_alerts reads the project's subscriptions as the user", async () => {
    const alerts = [{ id: "alert_1", type: "EMAIL", label: "k***@trigger.dev", enabled: true }];
    const { result, requests } = await callAlertTool("list_alerts", {}, { body: { alerts } });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://localhost:3030/api/v1/dashboard-agent/alerts?chatId=chat_alerts"
    );
    expect(requests[0]?.init?.method).toBe("GET");
    expect((requests[0]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer uat_token"
    );
    expect(result).toEqual({ alerts });
  });

  // The body below is exactly what `api.v1.dashboard-agent.alerts.ts` returns on success:
  // the channel flat, with no envelope around it.
  const CREATED_CHANNEL = {
    id: "alert_2",
    type: "EMAIL",
    target: "so…@example.com",
    enabled: true,
  };

  it("create_alert posts the email channel and reports the created alert", async () => {
    const { result, requests } = await callAlertTool(
      "create_alert",
      { email: "someone@example.com" },
      { body: CREATED_CHANNEL }
    );

    expect(requests[0]?.url).toBe("http://localhost:3030/api/v1/dashboard-agent/alerts");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      chatId: "chat_alerts",
      channel: "email",
      email: "someone@example.com",
    });
    expect(result).toEqual({ created: true, alert: CREATED_CHANNEL });

    // With no email the host defaults to the user's account email, so the body carries
    // only the chat scope and the channel.
    const noEmail = await callAlertTool("create_alert", {}, { body: CREATED_CHANNEL });
    expect(JSON.parse(String(noEmail.requests[0]?.init?.body))).toEqual({
      chatId: "chat_alerts",
      channel: "email",
    });
  });

  // `code` is the key both alert routes send a 403 refusal under.
  it("create_alert relays a 403 with the reason the host gave", async () => {
    const noEmailSetup = await callAlertTool(
      "create_alert",
      {},
      { status: 403, body: { error: "denied", code: "email_alerts_not_configured" } }
    );
    expect(noEmailSetup.result.error).toContain("isn't set up on this instance");
    expect(noEmailSetup.result.error).toContain("dashboard");

    const flag = await callAlertTool(
      "create_alert",
      {},
      { status: 403, body: { error: "denied", code: "dashboard_agent_disabled" } }
    );
    expect(flag.result.error).toContain("aren't enabled here");
  });

  it("create_alert relays the address refusal verbatim", async () => {
    const refused = await callAlertTool(
      "create_alert",
      { email: "someone@else.com" },
      {
        status: 400,
        body: {
          code: "email_not_allowed",
          error: "Alerts can only be sent to your own account email.",
        },
      }
    );
    expect(refused.result.error).toBe("Alerts can only be sent to your own account email.");
  });

  it("delete_alert deletes by id and surfaces a failure as text", async () => {
    const { result, requests } = await callAlertTool(
      "delete_alert",
      { alertId: "alert_1" },
      { body: { ok: true } }
    );
    expect(requests[0]?.url).toBe("http://localhost:3030/api/v1/dashboard-agent/alerts/alert_1");
    expect(requests[0]?.init?.method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, alertId: "alert_1" });

    const missing = await callAlertTool(
      "delete_alert",
      { alertId: "alert_gone" },
      { status: 404, body: { error: "No such alert." } }
    );
    expect(missing.result.error).toBe("No such alert.");
  });

  it("the alert tools fail closed with no delegated token, without hitting the network", async () => {
    for (const [name, input] of [
      ["list_alerts", {}],
      ["create_alert", {}],
      ["delete_alert", { alertId: "alert_1" }],
    ] as const) {
      const { result, requests } = await callAlertTool(name, input, { body: {} }, {});
      expect(typeof result.error).toBe("string");
      expect(requests).toHaveLength(0);
    }
  });
});

/**
 * The two tools whose output IS the panel's view model. `toModelOutput` is the seam:
 * the client keeps the full payload, the model gets a small one. The end-to-end
 * assertions go through `convertToModelMessages`, which is what actually replays a
 * stored transcript back to the provider.
 */
describe("the view-model tools don't echo the view back to the model", () => {
  const SCOPE = { projectRef: "proj_abc", environmentId: "env_abc" };

  const investigationState = {
    outcome: "concluded",
    severity: "warn",
    confidence: "high",
    title: "Why is send-order-receipt failing?",
    headline: "All three attempts ended in an error from the email provider.",
    remediation: "Raise minTimeoutInMs to 30s with a factor of 2.",
    hypotheses: [],
    evidence: [],
  };

  function investigationTools() {
    let next = 0;
    return buildDashboardAgentTools({
      ...SCOPE,
      investigations: {
        upsert: async () => ({
          ok: true as const,
          id: `inv_${++next}`,
          revision: 0,
          created: true,
        }),
      },
    });
  }

  type ViewModelTool = {
    inputSchema: { parse: (input: unknown) => unknown };
    execute: (input: unknown, opts: unknown) => Promise<any>;
    toModelOutput: (args: { toolCallId: string; input: any; output: any }) => any;
  };

  /** The tool-result part the panel stores and replays, as the SDK shapes it. */
  function toolMessage(toolName: string, input: unknown, output: unknown): UIMessage {
    return {
      id: `msg_${toolName}`,
      role: "assistant",
      parts: [
        {
          type: `tool-${toolName}`,
          toolCallId: "tc1",
          state: "output-available",
          input,
          output,
        } as UIMessage["parts"][number],
      ],
    };
  }

  async function replayedToolOutput(
    tools: ReturnType<typeof buildDashboardAgentTools>,
    message: UIMessage
  ) {
    const modelMessages = await convertToModelMessages([message], { tools });
    const part = modelMessages
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []))
      .find((p) => p.type === "tool-result");
    return (part as unknown as { output: { type: string; value: unknown } }).output;
  }

  it("render_view hands the blocks to the client and an acknowledgement to the model", async () => {
    const tools = investigationTools();
    const renderView = tools.render_view as ViewModelTool;

    const input = renderView.inputSchema.parse({
      blocks: [{ type: "investigation", investigation: investigationState }],
    });
    const output = await renderView.execute(input, {});

    // The client path is untouched: the canonicalized blocks are still the result.
    expect(output.blocks[0].investigation.title).toBe(investigationState.title);
    expect(output.investigationId).toBe("inv_1");

    // The model path carries identity and nothing else.
    const small = { type: "json", value: { ok: true, investigationId: "inv_1", revision: 0 } };
    expect(renderView.toModelOutput({ toolCallId: "tc1", input, output })).toEqual(small);

    // And that is what a replayed transcript sends, not the blocks.
    const replayed = await replayedToolOutput(tools, toolMessage("render_view", input, output));
    expect(replayed).toEqual(small);
    expect(JSON.stringify(replayed)).not.toContain(investigationState.headline);
    expect(JSON.stringify(replayed).length).toBeLessThan(
      JSON.stringify({ type: "json", value: output }).length / 4
    );
  });

  it("render_view still hands a render failure to the model verbatim", async () => {
    // No investigations capability, so the render is refused by name.
    const tools = buildDashboardAgentTools(SCOPE);
    const renderView = tools.render_view as ViewModelTool;
    const input = renderView.inputSchema.parse({
      blocks: [{ type: "investigation", investigation: investigationState }],
    });
    const output = await renderView.execute(input, {});

    expect(output.error).toContain("Investigations aren't available");
    expect(renderView.toModelOutput({ toolCallId: "tc1", input, output })).toEqual({
      type: "json",
      value: { ok: false, error: output.error },
    });
  });

  it("get_report keeps the card's detail off the model's copy", () => {
    const tools = buildDashboardAgentTools(SCOPE);
    const getReport = tools.get_report as ViewModelTool;

    // The curated view model the panel's report block reads.
    const output = {
      title: "Health",
      scope: "prod",
      period: "1h",
      baselineLabel: "the last 7 days",
      generatedAt: "2026-08-05T00:00:00.000Z",
      windowMinutes: 60,
      summary: { severity: "crit" },
      findings: [
        {
          type: "flow",
          severity: "crit",
          reason: "flow.throttled",
          metricIds: ["pending"],
          recommendation: { code: "flow.raise_limit" },
          observations: [{ code: "flow.dlq_growing", evidence: { dlq: 40 } }],
          exclusions: [{ code: "flow.not_deploy", evidence: { deploys: 0 } }],
        },
      ],
      metrics: [
        {
          id: "pending",
          value: 4200,
          unit: "count",
          aggregation: "max",
          normal: 40,
          severity: "crit",
          series: { points: Array.from({ length: 60 }, (_, i) => i * 3), kind: "measured" },
          breakdown: Object.fromEntries(
            Array.from({ length: 60 }, (_, i) => [`task/queue-${i}`, i * 7])
          ),
          annotation: { code: "pending.estimated", value: 4200 },
        },
      ],
      facts: { trustworthy: true, throughput: 12 },
      links: [{ key: "queues", label: "Queues", url: "/queues" }],
      footer: { code: "report.footer" },
      uri: "trigger://proj_abc/env_abc/report/health",
    };

    const modelOutput = getReport.toModelOutput({ toolCallId: "tc1", input: {}, output });
    const value = modelOutput.value as Record<string, any>;

    // What the answer is written from survives.
    expect(value.summary).toEqual({ severity: "crit" });
    expect(value.findings[0]).toMatchObject({ reason: "flow.throttled", severity: "crit" });
    expect(value.metrics[0]).toMatchObject({ id: "pending", value: 4200, normal: 40 });
    expect(value.facts).toEqual({ trustworthy: true, throughput: 12 });
    expect(value.uri).toBe(output.uri);

    // What only the card draws does not.
    const serialized = JSON.stringify(modelOutput);
    expect(serialized).not.toContain("breakdown");
    expect(serialized).not.toContain("observations");
    expect(serialized).not.toContain("footer");
    expect(serialized).not.toContain("series");
    expect(serialized).not.toContain("links");
    expect(serialized.length).toBeLessThan(JSON.stringify(output).length / 2);
  });

  it("get_report passes a failure through untouched", () => {
    const tools = buildDashboardAgentTools(SCOPE);
    const getReport = tools.get_report as ViewModelTool;
    const output = { error: "Couldn't get the health report (status 503)." };
    expect(getReport.toModelOutput({ toolCallId: "tc1", input: {}, output })).toEqual({
      type: "json",
      value: output,
    });
  });
});
