// Import the test harness first: it installs the resource catalog chat.agent
// registers its task functions in.
import { mockChatAgent, type MockChatAgentHarness } from "../../src/v3/test/index.js";

import {
  stepCountIs,
  streamText,
  tool,
  type PrepareStepFunction,
  type ToolSet,
  type UIMessage,
} from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../../src/v3/ai.js";
import { expectConsistentConversation, toolResultIdsIn, userTextsIn } from "./invariants.js";
import { makeGate, scriptedModel, userMessage, waitFor, type Step } from "./scripted.js";

/**
 * Whole conversations through a real chat.agent, on whichever AI SDK major
 * the vitest project resolves `ai` to. Every scenario runs in both forms a
 * caller writes `run()` in, and every model call is checked against
 * `expectConsistentConversation`; a scenario adds only what is specific to it.
 */

type Form = "bound streamText" | "spread toStreamTextOptions";
const forms: Form[] = ["bound streamText", "spread toStreamTextOptions"];

type AgentConfig = Parameters<typeof chat.agent>[0];

/** A `run()` in the given form, with the conversation's tools and model. */
function runIn(
  form: Form,
  model: ReturnType<typeof scriptedModel>["model"],
  tools: ToolSet,
  prepareStep?: PrepareStepFunction<ToolSet>
): AgentConfig["run"] {
  const options = {
    model,
    tools,
    stopWhen: stepCountIs(10),
    ...(prepareStep ? { prepareStep } : {}),
  };
  return form === "bound streamText"
    ? async ({ messages, signal, streamText: bound }) =>
        bound({ ...options, messages, abortSignal: signal })
    : async ({ messages, signal }) =>
        streamText({ ...chat.toStreamTextOptions(), ...options, messages, abortSignal: signal });
}

/** A tool whose result names the call it answers. */
const lookup = tool({
  inputSchema: z.object({}),
  execute: async (_input, { toolCallId }) => ({ for: toolCallId }),
});

/** Drives a conversation turn by turn, checking each turn ends cleanly. */
function converse(harness: MockChatAgentHarness, nextTurn: () => void) {
  const turns: string[] = [];
  let turnIndex = 0;
  return {
    turns,
    /** Starts the next turn with `text` and returns once it completes. */
    async say(text: string) {
      if (turns.length > 0) nextTurn();
      turns.push(text);
      const turn = await harness.sendMessage(userMessage(`u-${turnIndex++}`, text));
      expect(
        turn.chunks.filter((chunk) => chunk.type === "error"),
        `turn "${text}" ended in an error`
      ).toEqual([]);
      return turn;
    },
  };
}

describe.each(forms)("conversations through %s", (form) => {
  const id = (name: string) =>
    `conversation.${name}.${form === "bound streamText" ? "bound" : "spread"}`;

  // Catches: history across turns going missing or being sent twice, the
  // shape of "the model gets the previous message again on every turn".
  it("carries every turn into the next, once", async () => {
    const { model, calls, nextTurn } = scriptedModel([]);
    const agent = chat.agent({ id: id("text"), run: runIn(form, model, {}) });
    const harness = mockChatAgent(agent, { chatId: id("text") });
    try {
      const chat_ = converse(harness, nextTurn);
      await chat_.say("first question");
      await chat_.say("second question");
      await chat_.say("third question");

      expectConsistentConversation(calls, { turns: chat_.turns });
      expect(calls).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  // Catches: a tool loop whose later steps lose results, and results that
  // do not survive into the next turn.
  it("runs a sequential tool loop and keeps its results in the next turn", async () => {
    const script: Step[] = [
      { tools: ["lookup"] },
      { tools: ["lookup"] },
      { tools: ["lookup"] },
      { text: "looked it up" },
    ];
    const { model, calls, nextTurn } = scriptedModel(script);
    const agent = chat.agent({ id: id("tool-loop"), run: runIn(form, model, { lookup }) });
    const harness = mockChatAgent(agent, { chatId: id("tool-loop") });
    try {
      const chat_ = converse(harness, nextTurn);
      await chat_.say("look it up three times");
      await chat_.say("thanks");

      expectConsistentConversation(calls, { turns: chat_.turns });
      expect(toolResultIdsIn(calls.at(-1)!.prompt)).toEqual([
        "lookup-0-0",
        "lookup-1-0",
        "lookup-2-0",
      ]);
    } finally {
      await harness.close();
    }
  });

  // Catches: parallel tool results arriving out of call order, duplicated,
  // or dropped when the results are put back in call order between steps.
  it("runs parallel tool calls and keeps their results in call order", async () => {
    const slow = tool({
      inputSchema: z.object({}),
      execute: async (_input, { toolCallId }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { for: toolCallId };
      },
    });
    const script: Step[] = [
      { tools: ["slow", "lookup"] },
      { tools: ["slow", "lookup"] },
      { tools: ["lookup"] },
      { text: "done" },
    ];
    const { model, calls, nextTurn } = scriptedModel(script);
    const agent = chat.agent({
      id: id("parallel"),
      run: runIn(form, model, { slow, lookup }),
    });
    const harness = mockChatAgent(agent, { chatId: id("parallel") });
    try {
      const chat_ = converse(harness, nextTurn);
      await chat_.say("check both, twice");
      await chat_.say("and again");

      expectConsistentConversation(calls, { turns: chat_.turns });
      expect(toolResultIdsIn(calls[3]!.prompt)).toEqual([
        "slow-0-0",
        "lookup-0-1",
        "slow-1-0",
        "lookup-1-1",
        "lookup-2-0",
      ]);
    } finally {
      await harness.close();
    }
  });

  // Catches: a message steered into a running tool loop freezing the steps
  // after it, so the model never sees its newer tool results and repeats the
  // same call; and the steer being sent twice, or lost, in later turns.
  it("steers a message into a running tool loop and keeps going", async () => {
    const gate = makeGate();
    let entered = false;
    const waitForSteer = tool({
      inputSchema: z.object({}),
      execute: async (_input, { toolCallId }) => {
        entered = true;
        await gate.promise;
        return { for: toolCallId };
      },
    });
    const script: Step[] = [
      { tools: ["waitForSteer"] },
      { tools: ["lookup"] },
      { tools: ["lookup"] },
      { text: "steered answer" },
    ];
    const { model, calls, nextTurn } = scriptedModel(script);
    const agent = chat.agent({
      id: id("steer"),
      pendingMessages: { shouldInject: () => true },
      run: runIn(form, model, { waitForSteer, lookup }),
    });
    const harness = mockChatAgent(agent, { chatId: id("steer") });
    try {
      const chat_ = converse(harness, nextTurn);
      const first = chat_.say("start the long task");
      // Awaited below; this only keeps a failure while waiting from also
      // surfacing as an unhandled rejection that hides it.
      first.catch(() => {});
      await waitFor(() => entered, "the tool to start");
      await harness.sendPendingMessage(userMessage("steer-1", "also check the other one"));
      gate.open();
      await first;
      await chat_.say("summarise");

      expectConsistentConversation(calls, { turns: chat_.turns });
      expect(userTextsIn(calls[1]!.prompt)).toContain("also check the other one");
      expect(toolResultIdsIn(calls[3]!.prompt)).toEqual([
        "waitForSteer-0-0",
        "lookup-1-0",
        "lookup-2-0",
      ]);
      // The steer is part of the history once, not once per later prompt.
      expect(userTextsIn(calls.at(-1)!.prompt)).toContain("also check the other one");
    } finally {
      gate.open();
      await harness.close();
    }
  });

  // Catches: a mid-turn chat.inject freezing the steps after it, and the
  // injection being sent twice in later turns.
  it("keeps going after a tool injects a message mid-turn", async () => {
    const remind = tool({
      inputSchema: z.object({}),
      execute: async (_input, { toolCallId }) => {
        chat.inject([{ role: "user", content: "reminder from a tool" }]);
        return { for: toolCallId };
      },
    });
    const script: Step[] = [
      { tools: ["remind"] },
      { tools: ["lookup"] },
      { tools: ["lookup"] },
      { text: "reminded" },
    ];
    const { model, calls, nextTurn } = scriptedModel(script);
    const agent = chat.agent({ id: id("inject"), run: runIn(form, model, { remind, lookup }) });
    const harness = mockChatAgent(agent, { chatId: id("inject") });
    try {
      const chat_ = converse(harness, nextTurn);
      await chat_.say("do the reminding thing");
      await chat_.say("ok");

      expectConsistentConversation(calls, { turns: chat_.turns });
      expect(userTextsIn(calls[1]!.prompt)).toContain("reminder from a tool");
      expect(toolResultIdsIn(calls[3]!.prompt)).toEqual(["remind-0-0", "lookup-1-0", "lookup-2-0"]);
    } finally {
      await harness.close();
    }
  });

  // Catches: chat.getCompactionState() losing a field custom prepareStep code
  // relies on (the base response message count it slices from), which breaks
  // those callers at compile time and, in JavaScript, brings back compacted
  // history.
  it("exposes the compaction state custom prepareStep code reads", async () => {
    let compacted = 0;
    const seen: Array<ReturnType<typeof chat.getCompactionState>> = [];
    const inspect = tool({
      inputSchema: z.object({}),
      execute: async (_input, { toolCallId }) => {
        seen.push(chat.getCompactionState());
        return { for: toolCallId };
      },
    });
    const { model, nextTurn } = scriptedModel([
      { tools: ["lookup"] },
      { tools: ["inspect"] },
      { text: "inspected" },
    ]);
    const agent = chat.agent({
      id: id("compaction-state"),
      compaction: {
        shouldCompact: () => compacted === 0,
        summarize: async () => {
          compacted++;
          return "SUMMARY";
        },
      },
      run: runIn(form, model, { lookup, inspect }),
    });
    const harness = mockChatAgent(agent, { chatId: id("compaction-state") });
    try {
      await converse(harness, nextTurn).say("compact, then look");

      // One step (its assistant and tool messages) was summarised.
      expect(seen).toEqual([
        { summary: "SUMMARY", baseResponseMessageCount: 2, baseResponseStepCount: 1 },
      ]);
    } finally {
      await harness.close();
    }
  });

  // Catches: steps after a compaction between steps losing the tool results
  // that follow the summary, or bringing back what it replaced.
  it("compacts between steps and builds on the summary", async () => {
    let compacted = 0;
    const script: Step[] = [
      { tools: ["lookup"] },
      { tools: ["lookup"] },
      { tools: ["lookup"] },
      { text: "compacted answer" },
    ];
    const { model, calls, nextTurn } = scriptedModel(script);
    const agent = chat.agent({
      id: id("compact"),
      compaction: {
        // Once, at the boundary before the second step.
        shouldCompact: () => compacted === 0,
        summarize: async () => {
          compacted++;
          return "SUMMARY";
        },
      },
      run: runIn(form, model, { lookup }),
    });
    const harness = mockChatAgent(agent, { chatId: id("compact") });
    try {
      const chat_ = converse(harness, nextTurn);
      await chat_.say("a long task");
      await chat_.say("next");

      expect(compacted).toBe(1);
      expectConsistentConversation(calls, { turns: chat_.turns, compactedAt: 1 });
      // The summary opens every later step of the turn, and those steps keep
      // adding their own results after it.
      for (const call of calls.slice(1, 4)) expect(userTextsIn(call.prompt)[0]).toBe("SUMMARY");
      expect(toolResultIdsIn(calls[3]!.prompt)).toEqual(["lookup-1-0", "lookup-2-0"]);
      // The next turn starts from the summary and what followed it; nothing
      // the summary replaced comes back.
      const nextTurnPrompt = calls[4]!.prompt;
      expect(JSON.stringify(nextTurnPrompt[0])).toContain("SUMMARY");
      expect(toolResultIdsIn(nextTurnPrompt)).toEqual(["lookup-1-0", "lookup-2-0"]);
      expect(userTextsIn(nextTurnPrompt)).toEqual(["next"]);
    } finally {
      await harness.close();
    }
  });

  // Catches: a caller's own prepareStep that returns messages freezing the
  // steps after it.
  it("keeps going when the caller's prepareStep adds a message", async () => {
    const script: Step[] = [
      { tools: ["lookup"] },
      { tools: ["lookup"] },
      { tools: ["lookup"] },
      { text: "noted" },
    ];
    const { model, calls, nextTurn } = scriptedModel(script);
    const prepareStep: PrepareStepFunction<ToolSet> = async ({ messages, stepNumber }) =>
      stepNumber === 1
        ? { messages: [...messages, { role: "user", content: "a note from prepareStep" }] }
        : undefined;
    const agent = chat.agent({
      id: id("caller-prepare"),
      run: runIn(form, model, { lookup }, prepareStep),
    });
    const harness = mockChatAgent(agent, { chatId: id("caller-prepare") });
    try {
      const chat_ = converse(harness, nextTurn);
      await chat_.say("with a note");

      expectConsistentConversation(calls, { turns: chat_.turns });
      expect(userTextsIn(calls[1]!.prompt)).toContain("a note from prepareStep");
      expect(toolResultIdsIn(calls[3]!.prompt)).toEqual(["lookup-0-0", "lookup-1-0", "lookup-2-0"]);
    } finally {
      await harness.close();
    }
  });

  // Catches: a conversation picked up by a new run (after a restart or a
  // suspend) losing or repeating history from the snapshot.
  it("continues from a snapshot in a new run with the same history", async () => {
    const script: Step[] = [{ tools: ["lookup"] }, { text: "first answer" }];
    const { model, calls, nextTurn } = scriptedModel(script);
    const agent = chat.agent({ id: id("restart"), run: runIn(form, model, { lookup }) });
    const turns: string[] = [];

    const before = mockChatAgent(agent, { chatId: id("restart") });
    let snapshot: ReturnType<MockChatAgentHarness["getSnapshot"]>;
    try {
      const chat_ = converse(before, nextTurn);
      await chat_.say("before the restart");
      turns.push(...chat_.turns);
      snapshot = before.getSnapshot();
    } finally {
      await before.close();
    }

    const after = mockChatAgent(agent, {
      chatId: id("restart"),
      continuation: true,
      previousRunId: "run_before",
      snapshot,
    });
    try {
      nextTurn();
      turns.push("after the restart");
      const turn = await after.sendMessage(userMessage("u-after", "after the restart"));
      expect(turn.chunks.filter((chunk) => chunk.type === "error")).toEqual([]);

      expectConsistentConversation(calls, { turns });
      expect(toolResultIdsIn(calls.at(-1)!.prompt)).toEqual(["lookup-0-0"]);
    } finally {
      await after.close();
    }
  });
});

/**
 * Compaction run by a helper the caller wires into their own `streamText`,
 * outside the agent's managed options. Each helper has to forward the
 * `responseMessages` the AI SDK passes to `prepareStep`, or the steps after a
 * compaction lose their newest tool results on AI SDK 7.
 */
describe("compaction helpers in the caller's own streamText", () => {
  const script: Step[] = [
    { tools: ["lookup"] },
    { tools: ["lookup"] },
    { tools: ["lookup"] },
    { text: "compacted answer" },
  ];

  const expectSummaryThenNewResults = (calls: ReturnType<typeof scriptedModel>["calls"]) => {
    expectConsistentConversation(calls, { turns: ["a long task"], compactedAt: 1 });
    expect(userTextsIn(calls[1]!.prompt)[0]).toBe("SUMMARY");
    expect(toolResultIdsIn(calls[3]!.prompt)).toEqual(["lookup-1-0", "lookup-2-0"]);
  };

  // Catches: chat.compactionStep() not forwarding prepareStep's
  // responseMessages, so its steps after a compaction freeze on AI SDK 7.
  it("chat.compactionStep() keeps adding results after the summary", async () => {
    let compacted = 0;
    const { model, calls } = scriptedModel(script);
    const agent = chat.agent({
      id: "conversation.helpers.compaction-step",
      run: async ({ messages, signal }) =>
        streamText({
          model,
          messages,
          abortSignal: signal,
          tools: { lookup },
          stopWhen: stepCountIs(10),
          prepareStep: chat.compactionStep({
            shouldCompact: () => compacted === 0,
            summarize: async () => {
              compacted++;
              return "SUMMARY";
            },
          }),
        }),
    });
    const harness = mockChatAgent(agent, { chatId: "conversation.helpers.compaction-step" });
    try {
      await harness.sendMessage(userMessage("u-0", "a long task"));
      expect(compacted).toBe(1);
      expectSummaryThenNewResults(calls);
    } finally {
      await harness.close();
    }
  });

  // Catches: chat.MessageAccumulator's prepareStep() not forwarding
  // responseMessages, so its steps after a compaction freeze on AI SDK 7.
  it("MessageAccumulator.prepareStep() keeps adding results after the summary", async () => {
    let compacted = 0;
    let done = false;
    const { model, calls } = scriptedModel(script);
    const agent = chat.customAgent({
      id: "conversation.helpers.accumulator",
      run: async () => {
        const conversation = new chat.MessageAccumulator({
          compaction: {
            shouldCompact: () => compacted === 0,
            summarize: async () => {
              compacted++;
              return "SUMMARY";
            },
          },
        });
        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 60,
          timeout: "1h",
        });
        if (!next.ok) return;
        const wire = next.output as { message?: UIMessage; trigger: string };
        const messages = await conversation.addIncoming(
          wire.message ? [wire.message] : [],
          wire.trigger,
          0
        );
        const result = streamText({
          model,
          messages,
          prepareStep: conversation.prepareStep(),
          tools: { lookup },
          stopWhen: stepCountIs(10),
        });
        await chat.pipeAndCapture(result);
        done = true;
      },
    });
    const harness = mockChatAgent(agent, { chatId: "conversation.helpers.accumulator" });
    try {
      void harness.sendMessage(userMessage("u-0", "a long task")).catch(() => {});
      await waitFor(() => done, "the turn to finish");
      expect(compacted).toBe(1);
      expectSummaryThenNewResults(calls);
    } finally {
      await harness.close();
    }
  });
});
