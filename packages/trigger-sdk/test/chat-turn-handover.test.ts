// Import the test harness FIRST — installs the resource catalog so
// `chat.agent()` calls register their task functions correctly.
import { mockChatAgent, recordingChannelConnector } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import {
  type ApiClient,
  ApiConnectionError,
  ApiError,
  apiClientManager,
  resourceCatalog,
} from "@trigger.dev/core/v3";
import {
  __setApiUnavailableRetryDelaysForTests,
  __setReplaySessionInTailImplForTests,
  __setReplaySessionOutTailImplForTests,
  chat,
} from "../src/v3/ai.js";
import { memoryTranscriptStorage } from "../src/v3/transcriptStorage.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** Step 1 calls `lookup`; once its result follows the last user message, the next step answers. */
function twoStepModel(options?: { answerAfterAnyTool?: boolean }) {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const lastUser = options?.answerAfterAnyTool
        ? -1
        : prompt.map((message) => message.role).lastIndexOf("user");
      const answered = prompt.slice(lastUser + 1).some((message) => message.role === "tool");
      const chunks: LanguageModelV3StreamPart[] = answered
        ? [
            { type: "text-start", id: "t2" },
            { type: "text-delta", id: "t2", delta: "the answer" },
            { type: "text-end", id: "t2" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ]
        : [
            {
              type: "tool-call",
              toolCallId: `tc-${prompt.length}`,
              toolName: "lookup",
              input: "{}",
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The old run: deployed as 20260101.1, so a signal for 20260101.2 puts it below the threshold. */
const OLD_RUN = { taskContext: { ctx: { run: { version: "20260101.1" } } } };

const types = (chunks: readonly unknown[]) => chunks.map((c) => (c as { type?: string }).type);

/** An agent whose `lookup` tool blocks until `release()`, so a test can act while step 1 runs. */
function gatedAgent(
  id: string,
  options?: {
    pendingMessages?: Parameters<typeof chat.agent>[0]["pendingMessages"];
    versionSkew?: Parameters<typeof chat.agent>[0]["versionSkew"];
  }
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let toolStarted = false;
  const model = twoStepModel({ answerAfterAnyTool: options?.pendingMessages !== undefined });
  const onTurnStart = vi.fn();
  const onTurnComplete = vi.fn();
  const runMessages: string[][] = [];
  const tools = {
    lookup: tool({
      inputSchema: z.object({}),
      execute: async () => {
        toolStarted = true;
        await gate;
        return { found: true };
      },
    }),
  };
  const agent = chat.agent({
    id,
    versionSkew: options?.versionSkew ?? "follow-mid-turn",
    ...(options?.pendingMessages ? { pendingMessages: options.pendingMessages } : {}),
    onTurnStart,
    onTurnComplete,
    run: async ({ messages, signal }) => {
      runMessages.push(messages.map((message) => message.role));
      return streamText({
        ...chat.toStreamTextOptions(),
        model,
        messages,
        tools,
        stopWhen: stepCountIs(3),
        abortSignal: signal,
      });
    },
  });
  return {
    agent,
    model,
    onTurnStart,
    onTurnComplete,
    runMessages,
    release,
    toolStarted: () => toolStarted,
  };
}

describe("chat.agent mid-turn handover", () => {
  // Catches: the old run starting the next model call, or ending the turn (turn-complete,
  // onTurnComplete) when it was asked to hand over.
  it("stops at the step boundary, writes the marker and exits without completing the turn", async () => {
    const t = gatedAgent("handover.old-run");
    const harness = mockChatAgent(t.agent, { chatId: "handover-old", ...OLD_RUN });
    try {
      // Never resolves: this run writes no turn-complete.
      void harness.sendMessage(userMessage("go", "u-1")).catch(() => {});
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
      t.release();
      await harness.waitForExit(10_000);

      const seen = types(harness.allRawChunks);
      expect(seen).toContain("trigger:turn-handover");
      expect(seen).not.toContain("trigger:turn-complete");
      // Everything step 1 streamed is written before the marker, and nothing after it.
      expect(seen.indexOf("trigger:turn-handover")).toBe(seen.length - 1);
      expect(seen.lastIndexOf("finish-step")).toBeLessThan(seen.indexOf("trigger:turn-handover"));
      expect(seen).toContain("tool-output-available");
      expect(seen).not.toContain("text-delta");
      expect(
        harness.allRawChunks.find((c) => (c as { type?: string }).type === "trigger:turn-handover")
      ).toMatchObject({ handoverSteps: "1", handoverAnswered: "u-1" });
      expect(t.model.doStreamCalls).toHaveLength(1);
      expect(t.onTurnStart).toHaveBeenCalledTimes(1);
      expect(t.onTurnComplete).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  // Catches: the run handing a reply over not telling the server after which step, for which
  // reply and why, so the dashboard can't show where the reply moved.
  it("sends the steps, the reply's message id and the threshold on end-and-continue", async () => {
    const endAndContinueSession = vi.fn(async () => ({ runId: "run_next", swapped: true }));
    const client = vi
      .spyOn(apiClientManager, "clientOrThrow")
      .mockReturnValue({ endAndContinueSession } as unknown as ApiClient);
    const t = gatedAgent("handover.end-and-continue");
    const harness = mockChatAgent(t.agent, { chatId: "handover-eac", ...OLD_RUN });
    try {
      void harness.sendMessage(userMessage("go", "u-1")).catch(() => {});
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
      t.release();
      await harness.waitForExit(10_000);

      const start = harness.allRawChunks.find((c) => (c as { type?: string }).type === "start");
      expect(endAndContinueSession).toHaveBeenCalledWith(
        "handover-eac",
        expect.objectContaining({
          reason: "skew-threshold",
          handover: {
            afterSteps: 1,
            messageId: (start as { messageId?: string }).messageId,
            thresholdVersion: "20260101.2",
          },
        })
      );
    } finally {
      client.mockRestore();
      await harness.close();
    }
  });

  // Catches: the run giving up on the continuation at the first failed end-and-continue while the
  // API restarts, leaving the handed-over reply without a run.
  it("tries end-and-continue again while the API is unavailable", async () => {
    let calls = 0;
    const endAndContinueSession = vi.fn(async () => {
      if (++calls <= 2) throw new ApiConnectionError({ message: "fetch failed" });
      return { runId: "run_next", swapped: true };
    });
    const client = vi
      .spyOn(apiClientManager, "clientOrThrow")
      .mockReturnValue({ endAndContinueSession } as unknown as ApiClient);
    __setApiUnavailableRetryDelaysForTests([1, 1, 1]);
    const t = gatedAgent("handover.end-and-continue-retries");
    const harness = mockChatAgent(t.agent, { chatId: "handover-eac-retry", ...OLD_RUN });
    try {
      void harness.sendMessage(userMessage("go", "u-1")).catch(() => {});
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
      t.release();
      await harness.waitForExit(10_000);

      expect(endAndContinueSession).toHaveBeenCalledTimes(3);
      const seen = types(harness.allRawChunks);
      expect(seen.indexOf("trigger:turn-handover")).toBe(seen.length - 1);
    } finally {
      __setApiUnavailableRetryDelaysForTests(undefined);
      client.mockRestore();
      await harness.close();
    }
  });

  // Catches: a failed end-and-continue after the marker (the API stays down) hanging the run or
  // ending the turn: the run must exit with the marker last, so the server, seeing the run end on
  // the marker, starts a run that continues the reply from it.
  it("exits with the marker last when end-and-continue keeps failing", async () => {
    const endAndContinueSession = vi.fn(async () => {
      throw new ApiError(503, undefined, "Service Unavailable", undefined);
    });
    const client = vi
      .spyOn(apiClientManager, "clientOrThrow")
      .mockReturnValue({ endAndContinueSession } as unknown as ApiClient);
    __setApiUnavailableRetryDelaysForTests([1, 1]);
    const t = gatedAgent("handover.end-and-continue-fails");
    const harness = mockChatAgent(t.agent, { chatId: "handover-eac-fail", ...OLD_RUN });
    try {
      void harness.sendMessage(userMessage("go", "u-1")).catch(() => {});
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
      t.release();
      await harness.waitForExit(10_000);

      expect(endAndContinueSession).toHaveBeenCalledTimes(3);
      const seen = types(harness.allRawChunks);
      expect(seen.indexOf("trigger:turn-handover")).toBe(seen.length - 1);
      expect(seen).not.toContain("trigger:turn-complete");
      expect(t.onTurnComplete).not.toHaveBeenCalled();
      expect(t.model.doStreamCalls).toHaveLength(1);
    } finally {
      __setApiUnavailableRetryDelaysForTests(undefined);
      client.mockRestore();
      await harness.close();
    }
  });

  // Catches: a run at or above the threshold (the run that took the turn over, on the current
  // version), or a run of a task the threshold doesn't cover, handing its turn over.
  it("ignores the signal when the run isn't below its task's version", async () => {
    const t = gatedAgent("handover.not-below");
    const harness = mockChatAgent(t.agent, { chatId: "handover-not-below", ...OLD_RUN });
    try {
      const turn = harness.sendMessage(userMessage("go", "u-1"));
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.1" });
      await harness.sendSkewProtectionThresholdSignal({
        tasks: { "some-other-task": "20260101.2" },
      });
      t.release();
      const { rawChunks } = await turn;

      expect(types(rawChunks)).not.toContain("trigger:turn-handover");
      expect(types(rawChunks)).toContain("trigger:turn-complete");
      expect(t.model.doStreamCalls).toHaveLength(2);
      expect(t.onTurnComplete).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  // Catches: a threshold cleared during the step still handing the turn over.
  it("finishes the turn when a later signal clears the handover", async () => {
    const t = gatedAgent("handover.cleared");
    const harness = mockChatAgent(t.agent, { chatId: "handover-cleared", ...OLD_RUN });
    try {
      const turn = harness.sendMessage(userMessage("go", "u-1"));
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
      await harness.sendSkewProtectionThresholdSignal({});
      t.release();
      const { rawChunks } = await turn;

      expect(types(rawChunks)).not.toContain("trigger:turn-handover");
      expect(types(rawChunks)).toContain("trigger:turn-complete");
    } finally {
      await harness.close();
    }
  });

  // Catches: a task's own threshold (which overrides the environment's) being ignored.
  it("hands over on its task's own entry", async () => {
    const t = gatedAgent("handover.task-entry");
    const harness = mockChatAgent(t.agent, {
      chatId: "handover-task-entry",
      // In a real run ctx.task.id is the agent's id; the mock context defaults it to "test-task".
      taskContext: {
        ctx: { run: { version: "20260101.1" }, task: { id: "handover.task-entry" } },
      },
    });
    try {
      void harness.sendMessage(userMessage("go", "u-1")).catch(() => {});
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({
        tasks: { "handover.task-entry": "20260101.2" },
      });
      t.release();
      await harness.waitForExit(10_000);

      expect(types(harness.allRawChunks).at(-1)).toBe("trigger:turn-handover");
    } finally {
      await harness.close();
    }
  });

  // Catches: a turn that starts after the threshold was set (a warm old run) not handing over:
  // the turn's listener gets the latest signal when it starts listening.
  it("hands over the next turn when the signal was sent between turns", async () => {
    const t = gatedAgent("handover.between-turns");
    t.release();
    const harness = mockChatAgent(t.agent, { chatId: "handover-between", ...OLD_RUN });
    try {
      const first = await harness.sendMessage(userMessage("one", "u-1"));
      expect(types(first.rawChunks)).toContain("trigger:turn-complete");

      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
      void harness.sendMessage(userMessage("two", "u-2")).catch(() => {});
      await harness.waitForExit(10_000);

      const second = types(harness.allRawChunks).slice(first.rawChunks.length);
      expect(second.at(-1)).toBe("trigger:turn-handover");
      expect(second).not.toContain("trigger:turn-complete");
      // Two calls for the first turn, one for the second turn's first step.
      expect(t.model.doStreamCalls).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  // Catches: the new run answering the message again from step 1 (the default recovery), firing
  // onTurnStart a second time, or writing the rest of the reply under a new message id.
  it("continues a handed-over reply from the next step under the same message id", async () => {
    const t = gatedAgent("handover.new-run");
    t.release();
    const handedOver = {
      id: "a-handed-over",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-lookup",
          toolCallId: "tc-1",
          state: "output-available",
          input: {},
          output: { found: true },
        },
      ],
    } as unknown as UIMessage;
    const harness = mockChatAgent(t.agent, {
      chatId: "handover-new",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([userMessage("go", "u-1")]);
    harness.seedSessionOutPartial(handedOver);
    harness.seedSessionOutHandover(1);
    try {
      await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));

      // One model call, for the step after the tool result: the tool did not run again.
      expect(t.model.doStreamCalls).toHaveLength(1);
      expect(t.toolStarted()).toBe(false);
      expect(t.runMessages).toEqual([["user", "assistant", "tool"]]);
      expect(t.onTurnStart).not.toHaveBeenCalled();
      expect(t.onTurnComplete).toHaveBeenCalledTimes(1);

      const event = t.onTurnComplete.mock.calls[0]![0];
      expect(event.responseMessage.id).toBe("a-handed-over");
      expect(event.responseMessage.parts.map((part: { type: string }) => part.type)).toEqual([
        "step-start",
        "tool-lookup",
        "step-start",
        "text",
      ]);
      expect(event.newUIMessages.map((message: UIMessage) => message.id)).toEqual([
        "u-1",
        "a-handed-over",
      ]);
      expect(harness.allChunks.find((chunk) => chunk.type === "start")).toMatchObject({
        messageId: "a-handed-over",
      });
    } finally {
      await harness.close();
    }
  });

  describe("during the pause", () => {
    // Catches: a stop pressed while the turn was being handed over being lost, so the new run
    // made another model call and finished a reply the person had stopped.
    it("a stop ends the reply where the previous run left it, with no model call", async () => {
      const t = gatedAgent("handover.pause-stop");
      t.release();
      const harness = handedOverRun(t, "handover-pause-stop", [
        userMessage("go", "u-1"),
        { stop: true },
      ]);
      try {
        await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));

        expect(t.model.doStreamCalls).toHaveLength(0);
        expect(t.runMessages).toEqual([]);
        expect(t.onTurnStart).not.toHaveBeenCalled();
        expect(t.onTurnComplete).toHaveBeenCalledTimes(1);
        const event = t.onTurnComplete.mock.calls[0]![0];
        expect(event.stopped).toBe(true);
        expect(event.responseMessage.id).toBe("a-handed-over");
        expect(event.responseMessage.parts.map((part: { type: string }) => part.type)).toEqual([
          "step-start",
          "tool-lookup",
        ]);
        expect(types(harness.allRawChunks)).not.toContain("text-delta");
      } finally {
        await harness.close();
      }
    });

    // Catches: a stop that landed between the boot's tail read and the router's own read of the
    // replay window: inside the window but in neither read, so it was dropped as replayed and the
    // new run finished a reply the person had stopped.
    it("a stop that lands while the run boots ends the reply", async () => {
      const readSessionStreamRecords = vi.fn(async () => ({
        records: [{ seqNum: 2, data: JSON.stringify({ kind: "stop" }), headers: [] }],
      }));
      const spy = vi
        .spyOn(apiClientManager, "clientOrThrow")
        .mockReturnValue({ readSessionStreamRecords } as unknown as ApiClient);
      const t = gatedAgent("handover.boot-stop");
      t.release();
      const harness = handedOverRun(t, "handover-boot-stop", [userMessage("go", "u-1")]);
      void harness.deliverSessionInAtSeq({ stop: true }, 2);
      try {
        await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));

        expect(t.model.doStreamCalls).toHaveLength(0);
        expect(t.onTurnComplete.mock.calls[0]![0].stopped).toBe(true);
      } finally {
        spy.mockRestore();
        await harness.close();
      }
    });

    for (const withPending of [true, false]) {
      // Catches: a steer the previous run already injected into the reply being lost from the
      // model's context (its marker needs the message, which was only on `.in`), offered to
      // pendingMessages again, or answered again as its own turn.
      it(`a steer injected before the handover stays in the reply once (pendingMessages: ${withPending})`, async () => {
        const shouldInject = vi.fn(() => true);
        const t = gatedAgent(
          `handover.injected-steer.${withPending}`,
          withPending ? { pendingMessages: { shouldInject } } : undefined
        );
        t.release();
        const harness = mockChatAgent(t.agent, {
          chatId: `handover-injected-steer-${withPending}`,
          continuation: true,
          previousRunId: "run_prior",
        });
        harness.seedSessionInTail([userMessage("go", "u-1"), userMessage("keep it short", "u-2")]);
        harness.seedSessionOutPartial({
          id: "a-handed-over",
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "tool-lookup",
              toolCallId: "tc-1",
              state: "output-available",
              input: {},
              output: { found: true },
            },
            {
              type: "data-pending-message-injected",
              id: "injection-1",
              data: { messageIds: ["u-2"], messages: [{ id: "u-2", text: "keep it short" }] },
            },
            { type: "step-start" },
            {
              type: "tool-lookup",
              toolCallId: "tc-2",
              state: "output-available",
              input: {},
              output: { found: true },
            },
          ],
        } as unknown as UIMessage);
        harness.seedSessionOutHandover(2, "u-1");
        try {
          await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));
          // Room for a second turn to start if the steer were also queued as one.
          await new Promise((resolve) => setTimeout(resolve, 200));

          expect(shouldInject).not.toHaveBeenCalled();
          expect(t.model.doStreamCalls).toHaveLength(1);
          expect(
            JSON.stringify(t.model.doStreamCalls[0]!.prompt).split("keep it short")
          ).toHaveLength(2);
          expect(t.onTurnComplete).toHaveBeenCalledTimes(1);
          expect(
            t.onTurnComplete.mock.calls[0]![0].newUIMessages.map((m: UIMessage) => m.id)
          ).toEqual(["u-1", "u-2", "a-handed-over"]);
        } finally {
          await harness.close();
        }
      });
    }

    // Catches: a message sent during the pause being answered before the continued turn, or
    // the continued turn being dropped for it.
    it("a message is answered after the continued turn, in order", async () => {
      const t = gatedAgent("handover.pause-message");
      t.release();
      const harness = handedOverRun(t, "handover-pause-message", [
        userMessage("go", "u-1"),
        userMessage("and then?", "u-2"),
      ]);
      try {
        await waitFor(() => t.onTurnComplete.mock.calls.length === 2);

        const [first, second] = t.onTurnComplete.mock.calls.map((call) => call[0]);
        expect(first.responseMessage.id).toBe("a-handed-over");
        expect(first.stopped).toBe(false);
        expect(second.newUIMessages[0].id).toBe("u-2");
        // One call continues the reply; the second turn takes two (tool, then answer).
        expect(t.model.doStreamCalls).toHaveLength(3);
        expect(t.onTurnStart).toHaveBeenCalledTimes(1);
      } finally {
        await harness.close();
      }
    });

    // Catches: a steer sent during the pause becoming a later turn instead of reaching
    // `pendingMessages` at the step boundary, as it would have on one run.
    it("a steer reaches pendingMessages at the step boundary", async () => {
      const shouldInject = vi.fn(() => true);
      const t = gatedAgent("handover.pause-steer", { pendingMessages: { shouldInject } });
      t.release();
      const harness = handedOverRun(t, "handover-pause-steer", [
        userMessage("go", "u-1"),
        userMessage("keep it short", "u-2"),
      ]);
      try {
        await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));
        // Room for a second turn to start if the steer were also queued as one.
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(shouldInject).toHaveBeenCalled();
        expect(t.model.doStreamCalls).toHaveLength(1);
        expect(JSON.stringify(t.model.doStreamCalls[0]!.prompt)).toContain("keep it short");
        expect(t.onTurnComplete).toHaveBeenCalledTimes(1);
        const event = t.onTurnComplete.mock.calls[0]![0];
        expect(event.responseMessage.id).toBe("a-handed-over");
        expect(event.newUIMessages.map((message: UIMessage) => message.id)).toContain("u-2");
      } finally {
        await harness.close();
      }
    });
  });
});

/** The new run of a turn handed over after step 1, with `tail` on `session.in`. */
function handedOverRun(
  t: { agent: Parameters<typeof mockChatAgent>[0] },
  chatId: string,
  tail: Parameters<ReturnType<typeof mockChatAgent>["seedSessionInTail"]>[0],
  version?: string
) {
  const harness = mockChatAgent(t.agent, {
    chatId,
    continuation: true,
    previousRunId: "run_prior",
    ...(version ? { taskContext: { ctx: { run: { version } } } } : {}),
  });
  harness.seedSessionInTail(tail);
  harness.seedSessionOutPartial({
    id: "a-handed-over",
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "tool-lookup",
        toolCallId: "tc-1",
        state: "output-available",
        input: {},
        output: { found: true },
      },
    ],
  } as unknown as UIMessage);
  harness.seedSessionOutHandover(1);
  return harness;
}

/** A `chat.createSession` loop whose `lookup` tool blocks until `release()`. */
function gatedSessionAgent(
  id: string,
  mode: "turn-prepare-step" | "own-prepare-step",
  versionSkew: "follow" | "follow-mid-turn" = "follow-mid-turn"
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let toolStarted = false;
  const model = twoStepModel();
  const turns: Array<{ handedOver: boolean; stopped: boolean; response?: UIMessage }> = [];
  const tools = {
    lookup: tool({
      inputSchema: z.object({}),
      execute: async () => {
        toolStarted = true;
        await gate;
        return { found: true };
      },
    }),
  };
  const agent = chat.customAgent({
    id,
    run: async (payload, { signal }) => {
      for await (const turn of chat.createSession(payload, { signal, versionSkew })) {
        const result = streamText({
          model,
          messages: turn.messages,
          tools,
          stopWhen: stepCountIs(3),
          abortSignal: turn.signal,
          prepareStep:
            mode === "turn-prepare-step"
              ? turn.prepareStep()
              : async (step) => {
                  await chat.handOverAtStep(step);
                  return undefined;
                },
        });
        const response = await turn.complete(result);
        turns.push({ handedOver: turn.handedOver, stopped: turn.stopped, response });
      }
    },
  });
  return { agent, model, turns, release, toolStarted: () => toolStarted };
}

describe("versionSkew decides whether a turn moves mid-turn", () => {
  // Catches: an agent without "follow-mid-turn" handing a running turn over (it finishes on its
  // version; the session moves at the next message).
  for (const versionSkew of ["follow", "hold"] as const) {
    it(`finishes the turn on its version with versionSkew "${versionSkew}"`, async () => {
      const t = gatedAgent(`handover.off-${versionSkew}`, { versionSkew });
      const harness = mockChatAgent(t.agent, { chatId: `handover-off-${versionSkew}`, ...OLD_RUN });
      try {
        const turn = harness.sendMessage(userMessage("go", "u-1"));
        await waitFor(t.toolStarted);
        await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
        t.release();
        const { rawChunks } = await turn;

        expect(types(rawChunks)).not.toContain("trigger:turn-handover");
        expect(types(rawChunks)).toContain("trigger:turn-complete");
        expect(t.model.doStreamCalls).toHaveLength(2);
      } finally {
        await harness.close();
      }
    });
  }

  // Catches: a turn handed to a current deployment whose task can't continue it (an older SDK,
  // or the task isn't an agent there), which would answer the turn again from its first step.
  it("finishes the turn when its task's current deployment can't continue it", async () => {
    const t = gatedAgent("handover.cant-upgrade");
    const harness = mockChatAgent(t.agent, { chatId: "handover-cant-upgrade", ...OLD_RUN });
    try {
      const turn = harness.sendMessage(userMessage("go", "u-1"));
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({
        environment: "20260101.2",
        midTurnTasks: ["some-other-agent"],
      });
      t.release();
      const { rawChunks } = await turn;

      expect(types(rawChunks)).not.toContain("trigger:turn-handover");
      expect(types(rawChunks)).toContain("trigger:turn-complete");
    } finally {
      await harness.close();
    }
  });

  // Catches: chat.handOverAtStep() in a custom loop moving a turn the loop didn't opt in for.
  it("chat.handOverAtStep() does nothing in a createSession loop without follow-mid-turn", async () => {
    const t = gatedSessionAgent("handover.session-off", "own-prepare-step", "follow");
    const harness = mockChatAgent(t.agent, { chatId: "handover-session-off", ...OLD_RUN });
    try {
      const turn = harness.sendMessage(userMessage("go", "u-1"));
      await waitFor(t.toolStarted);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
      t.release();
      const { rawChunks } = await turn;

      expect(types(rawChunks)).not.toContain("trigger:turn-handover");
      expect(types(rawChunks)).toContain("trigger:turn-complete");
      expect(t.turns[0]!.handedOver).toBe(false);
    } finally {
      await harness.close();
    }
  });
});

describe("a turn answering a channel delivery", () => {
  // Catches: a channel reply handed to a run that doesn't have the delivery, so the answer never
  // posts back and the delivery is processed again as a new turn.
  it("finishes on its run and posts the reply through the connector", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let toolStarted = false;
    const channel = recordingChannelConnector();
    const model = twoStepModel();
    const agent = chat.agent({
      id: "handover.channel-turn",
      versionSkew: "follow-mid-turn",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({
          ...chat.toStreamTextOptions(),
          model,
          messages,
          tools: {
            lookup: tool({
              inputSchema: z.object({}),
              execute: async () => {
                toolStarted = true;
                await gate;
                return { found: true };
              },
            }),
          },
          stopWhen: stepCountIs(3),
          abortSignal: signal,
        }),
    });
    const harness = mockChatAgent(agent, { chatId: "handover-channel", ...OLD_RUN });
    try {
      const delivered = harness.sendChannelEvent({
        event: { text: "go", threadId: "handover-channel" },
      });
      await waitFor(() => toolStarted);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
      release();
      await delivered;

      expect(types(harness.allRawChunks)).not.toContain("trigger:turn-handover");
      expect(model.doStreamCalls).toHaveLength(2);
      expect(channel.finalText()).toBe("the answer");
    } finally {
      await harness.close();
    }
  });
});

describe("the agent config in the manifest", () => {
  // Catches: the server never handing a turn to a deployment that can continue it, because the
  // agent didn't say so (the server reads `turnHandover` per task, not the SDK version).
  it("says chat.agent and chat.customAgent can continue a handed-over turn", () => {
    gatedAgent("handover.manifest-agent");
    gatedSessionAgent("handover.manifest-custom", "turn-prepare-step");
    expect(resourceCatalog.getTask("handover.manifest-agent")?.agentConfig).toMatchObject({
      turnHandover: true,
    });
    expect(resourceCatalog.getTask("handover.manifest-custom")?.agentConfig).toEqual({
      type: "ai-sdk-chat",
      turnHandover: true,
    });
  });
});

describe("two handovers in one turn", () => {
  // Catches: the run that took a turn over (v2) not handing it on when a later threshold (v3)
  // arrives mid-turn, or re-running a step it continued from.
  it("the run that continued a reply hands it over again at its next step boundary", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const toolCalls: string[] = [];
    // Steps 1 and 2 call `lookup`, step 3 answers; the step is the number of tool results so far.
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const results = prompt.filter((message) => message.role === "tool").length;
        const chunks: LanguageModelV3StreamPart[] =
          results >= 2
            ? [
                { type: "text-start", id: "t3" },
                { type: "text-delta", id: "t3", delta: "the answer" },
                { type: "text-end", id: "t3" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ]
            : [
                {
                  type: "tool-call",
                  toolCallId: `tc-${results + 1}`,
                  toolName: "lookup",
                  input: "{}",
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage,
                },
              ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    const agent = chat.agent({
      id: "handover.twice",
      versionSkew: "follow-mid-turn",
      run: async ({ messages, signal }) =>
        streamText({
          ...chat.toStreamTextOptions(),
          model,
          messages,
          tools: {
            lookup: tool({
              inputSchema: z.object({}),
              execute: async (_input, { toolCallId }) => {
                toolCalls.push(toolCallId);
                await gate;
                return { found: true };
              },
            }),
          },
          stopWhen: stepCountIs(5),
          abortSignal: signal,
        }),
    });
    const harness = handedOverRun(
      { agent },
      "handover-twice",
      [userMessage("go", "u-1")],
      "20260101.2"
    );
    try {
      await waitFor(() => toolCalls.length === 1);
      await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.3" });
      release();
      await harness.waitForExit(10_000);

      const seen = types(harness.allRawChunks);
      expect(seen.at(-1)).toBe("trigger:turn-handover");
      expect(seen).not.toContain("trigger:turn-complete");
      // Step 2 only: step 1 was the first run's, and step 3 is the next run's.
      expect(toolCalls).toEqual(["tc-2"]);
      expect(model.doStreamCalls).toHaveLength(1);
      expect(harness.allChunks.filter((chunk) => chunk.type === "start")).toEqual([
        expect.objectContaining({ messageId: "a-handed-over" }),
      ]);
      // Catches: the second handover counting only this run's steps (1), so the dashboard drew
      // the move after step 1 of a reply that had 2.
      expect(
        harness.allRawChunks.find((c) => (c as { type?: string }).type === "trigger:turn-handover")
      ).toMatchObject({ handoverSteps: "2" });
    } finally {
      await harness.close();
    }
  });
});

describe("chat.requestUpgrade() during a turn", () => {
  // Catches: requestUpgrade() from a tool waiting for the whole turn to end instead of handing
  // the turn over at the next step boundary.
  it("hands the turn over at the next step boundary", async () => {
    const model = twoStepModel();
    const onTurnComplete = vi.fn();
    const agent = chat.agent({
      id: "handover.request-upgrade",
      onTurnComplete,
      run: async ({ messages, signal }) =>
        streamText({
          ...chat.toStreamTextOptions(),
          model,
          messages,
          tools: {
            lookup: tool({
              inputSchema: z.object({}),
              execute: async () => {
                chat.requestUpgrade();
                return { found: true };
              },
            }),
          },
          stopWhen: stepCountIs(3),
          abortSignal: signal,
        }),
    });
    const harness = mockChatAgent(agent, { chatId: "handover-request-upgrade" });
    try {
      void harness.sendMessage(userMessage("go", "u-1")).catch(() => {});
      await harness.waitForExit(10_000);

      const seen = types(harness.allRawChunks);
      expect(seen.at(-1)).toBe("trigger:turn-handover");
      expect(seen).not.toContain("trigger:turn-complete");
      expect(seen).not.toContain("trigger:upgrade-required");
      // The server continues it as an upgrade if this run can't start the next one.
      expect(
        harness.allRawChunks.find((c) => (c as { type?: string }).type === "trigger:turn-handover")
      ).toMatchObject({ handoverUpgrade: "" });
      expect(model.doStreamCalls).toHaveLength(1);
      expect(onTurnComplete).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

// Catches: an agent that supplies its own context (hydrateMessages, or the storage's loadContext)
// losing the handed-over steps: the hook's history ends before them, since the previous run never
// reached onTurnComplete, so the tool ran again and the reply got a new message id.
describe("a handed-over turn with the context supplied by the app", () => {
  const stored = [userMessage("go", "u-1")];
  const contextOptions = {
    hydrateMessages: {
      hydrateMessages: async ({ incomingMessages }: { incomingMessages: UIMessage[] }) => [
        ...stored,
        ...incomingMessages,
      ],
    },
    loadContext: {
      storage: {
        ...memoryTranscriptStorage(),
        loadContext: async (_scope: unknown, event: { incomingMessages: UIMessage[] }) => [
          ...stored,
          ...event.incomingMessages,
        ],
      },
    },
  };
  for (const [name, options] of Object.entries(contextOptions)) {
    it(`continues from the next step under the same message id (${name})`, async () => {
      const model = twoStepModel();
      let toolRuns = 0;
      const onTurnComplete = vi.fn();
      const agent = chat.agent({
        id: `handover.context.${name}`,
        versionSkew: "follow-mid-turn",
        ...(options as object),
        onTurnComplete,
        run: async ({ messages, signal }) =>
          streamText({
            ...chat.toStreamTextOptions(),
            model,
            messages,
            tools: {
              lookup: tool({
                inputSchema: z.object({}),
                execute: async () => {
                  toolRuns++;
                  return { found: true };
                },
              }),
            },
            stopWhen: stepCountIs(3),
            abortSignal: signal,
          }),
      });
      const harness = handedOverRun({ agent }, `handover-context-${name}`, [
        userMessage("go", "u-1"),
      ]);
      try {
        await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));

        expect(toolRuns).toBe(0);
        expect(model.doStreamCalls).toHaveLength(1);
        expect(model.doStreamCalls[0]!.prompt.map((m) => m.role)).toEqual([
          "user",
          "assistant",
          "tool",
        ]);
        expect(onTurnComplete.mock.calls[0]?.[0]?.responseMessage?.id).toBe("a-handed-over");
      } finally {
        await harness.close();
      }
    });
  }
});

// Catches: a message sent during the pause taken as the one the reply answers when that one came
// in the run's payload (never on `.in`): it was folded into the continued reply and never got its
// own turn.
describe("a handed-over turn whose message came in the payload", () => {
  it("chat.agent answers a message sent during the pause as its own turn", async () => {
    const t = gatedAgent("handover.payload-answered.agent");
    t.release();
    const harness = handedOverRun(t, "handover-payload-answered-agent", [
      userMessage("and then?", "u-2"),
    ]);
    harness.seedSessionOutHandover(1, "u-1");
    try {
      await waitFor(() => t.onTurnComplete.mock.calls.length === 2);

      const turns = t.onTurnComplete.mock.calls.map((call) => ({
        response: call[0].responseMessage.id,
        newIds: call[0].newUIMessages.map((m: UIMessage) => m.id),
      }));
      expect(turns[0]!.response).toBe("a-handed-over");
      expect(turns[0]!.newIds).not.toContain("u-2");
      expect(turns[1]!.newIds).toContain("u-2");
    } finally {
      await harness.close();
    }
  });

  it("chat.createSession answers a message sent during the pause as its own turn", async () => {
    const t = gatedSessionAgent("handover.payload-answered.session", "turn-prepare-step");
    t.release();
    const harness = handedOverRun(t, "handover-payload-answered-session", [
      userMessage("and then?", "u-2"),
    ]);
    harness.seedSessionOutHandover(1, "u-1");
    try {
      await waitFor(() => t.turns.length === 1);
      // The live tail delivers what the boot read (chat.customAgent's router is attached).
      await harness.deliverSessionInAtSeq(userMessage("and then?", "u-2"), 1);
      await waitFor(() => t.turns.length === 2);

      expect(t.turns[0]!.response?.id).toBe("a-handed-over");
      expect(t.turns[1]!.response?.id).not.toBe("a-handed-over");
      const lastPrompt = JSON.stringify(t.model.doStreamCalls.at(-1)!.prompt);
      expect(lastPrompt).toContain("and then?");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.createSession mid-turn handover", () => {
  for (const mode of ["turn-prepare-step", "own-prepare-step"] as const) {
    // Catches: a custom loop never handing over (no step hook of ours), or finishing the turn
    // (turn-complete) when it was asked to hand over.
    it(`stops at the step boundary and ends the loop (${mode})`, async () => {
      const t = gatedSessionAgent(`handover.session-old.${mode}`, mode);
      const harness = mockChatAgent(t.agent, {
        chatId: `handover-session-old-${mode}`,
        ...OLD_RUN,
      });
      try {
        void harness.sendMessage(userMessage("go", "u-1")).catch(() => {});
        await waitFor(t.toolStarted);
        await harness.sendSkewProtectionThresholdSignal({ environment: "20260101.2" });
        t.release();
        await harness.waitForExit(10_000);

        const seen = types(harness.allRawChunks);
        expect(seen.at(-1)).toBe("trigger:turn-handover");
        expect(seen).not.toContain("trigger:turn-complete");
        expect(seen).toContain("tool-output-available");
        expect(t.model.doStreamCalls).toHaveLength(1);
        expect(t.turns).toHaveLength(1);
        expect(t.turns[0]!.handedOver).toBe(true);
      } finally {
        await harness.close();
      }
    });
  }

  // Catches: the new run of a custom loop waiting for a new message instead of continuing the
  // handed-over reply, or writing the rest under a new message id.
  it("continues a handed-over reply from the next step under the same message id", async () => {
    const t = gatedSessionAgent("handover.session-new", "turn-prepare-step");
    t.release();
    const harness = handedOverRun(t, "handover-session-new", [userMessage("go", "u-1")]);
    try {
      await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));

      expect(t.model.doStreamCalls).toHaveLength(1);
      expect(t.toolStarted()).toBe(false);
      expect(t.model.doStreamCalls[0]!.prompt.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
      ]);
      expect(t.turns).toHaveLength(1);
      expect(t.turns[0]!.response?.id).toBe("a-handed-over");
      expect(t.turns[0]!.response?.parts.map((part) => part.type)).toEqual([
        "step-start",
        "tool-lookup",
        "step-start",
        "text",
      ]);
      expect(harness.allChunks.find((chunk) => chunk.type === "start")).toMatchObject({
        messageId: "a-handed-over",
      });

      // Catches: the live tail delivering the answered message again (chat.customAgent attaches
      // the router before the loop reads the handover), so it was answered a second time.
      await harness.deliverSessionInAtSeq(userMessage("go", "u-1"), 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(t.model.doStreamCalls).toHaveLength(1);
      expect(t.turns).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // Catches: a steer the previous run already injected into the reply answered again as its own
  // turn, or missing from the model's context (its marker needs the message, only on `.in`).
  it("keeps a steer injected before the handover in the reply once", async () => {
    const t = gatedSessionAgent("handover.session-injected-steer", "turn-prepare-step");
    t.release();
    const harness = mockChatAgent(t.agent, {
      chatId: "handover-session-injected-steer",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([userMessage("go", "u-1"), userMessage("keep it short", "u-2")]);
    harness.seedSessionOutPartial({
      id: "a-handed-over",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-lookup",
          toolCallId: "tc-1",
          state: "output-available",
          input: {},
          output: { found: true },
        },
        {
          type: "data-pending-message-injected",
          id: "injection-1",
          data: { messageIds: ["u-2"], messages: [{ id: "u-2", text: "keep it short" }] },
        },
        { type: "step-start" },
        {
          type: "tool-lookup",
          toolCallId: "tc-2",
          state: "output-available",
          input: {},
          output: { found: true },
        },
      ],
    } as unknown as UIMessage);
    harness.seedSessionOutHandover(2, "u-1");
    try {
      await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));
      // The live tail delivers the steer's record too (the router attaches before the loop).
      await harness.deliverSessionInAtSeq(userMessage("keep it short", "u-2"), 2);
      // Room for a second turn to start if the steer were also queued as one.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(t.model.doStreamCalls).toHaveLength(1);
      expect(JSON.stringify(t.model.doStreamCalls[0]!.prompt).split("keep it short")).toHaveLength(
        2
      );
      expect(t.turns).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  // Catches: the run continuing a handed-over reply following the session's pin first (a pin
  // below the threshold it was moved past), so it asked to move again and never answered.
  it("continues a handed-over reply without following the session's pin", async () => {
    const endAndContinueSession = vi.fn(async () => ({ runId: "run_next", swapped: true }));
    const retrieveSession = vi.fn(async () => ({
      id: "session_x",
      triggerConfig: { basePayload: {}, externalDeploymentId: "dep-A" },
    }));
    const spy = vi
      .spyOn(apiClientManager, "clientOrThrow")
      .mockReturnValue({ endAndContinueSession, retrieveSession } as unknown as ApiClient);
    const model = twoStepModel();
    const agent = chat.customAgent({
      id: "handover.session-pinned",
      run: async (payload, { signal, ctx }) => {
        (ctx as { deployment?: unknown }).deployment = { externalId: "dep-B" };
        for await (const turn of chat.createSession(payload, { signal })) {
          await turn.complete(
            streamText({
              model,
              messages: turn.messages,
              tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => ({}) }) },
              stopWhen: stepCountIs(3),
              abortSignal: turn.signal,
              prepareStep: turn.prepareStep(),
            })
          );
        }
      },
    });
    const harness = handedOverRun({ agent }, "handover-session-pinned", [userMessage("go", "u-1")]);
    try {
      await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));

      expect(types(harness.allRawChunks)).not.toContain("trigger:upgrade-required");
      expect(endAndContinueSession).not.toHaveBeenCalled();
      expect(model.doStreamCalls).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await harness.close();
    }
  });

  // Catches: a stop sent during the handover being lost in a custom loop.
  it("a stop during the pause ends the reply where the previous run left it", async () => {
    const t = gatedSessionAgent("handover.session-stop", "turn-prepare-step");
    t.release();
    const harness = handedOverRun(t, "handover-session-stop", [
      userMessage("go", "u-1"),
      { stop: true },
    ]);
    try {
      await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));

      expect(types(harness.allRawChunks)).not.toContain("text-delta");
      expect(t.turns).toEqual([
        expect.objectContaining({
          stopped: true,
          response: expect.objectContaining({ id: "a-handed-over" }),
        }),
      ]);
    } finally {
      await harness.close();
    }
  });
});

describe("a run continuing a handed-over turn while the API is unavailable", () => {
  const handedOverPartial = {
    id: "a-handed-over",
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "tool-lookup",
        toolCallId: "tc-1",
        state: "output-available",
        input: {},
        output: { found: true },
      },
    ],
  } as unknown as UIMessage;

  /** `.out` reads fail `failures` times while the API doesn't answer, then return the handover. */
  function outUnreadableFor(failures: number) {
    let reads = 0;
    __setReplaySessionOutTailImplForTests(async () => {
      if (++reads <= failures) throw new ApiConnectionError({ message: "fetch failed" });
      return {
        settled: [],
        partial: handedOverPartial,
        partialRaw: handedOverPartial,
        handover: { steps: 1 },
      } as never;
    });
    return () => reads;
  }

  for (const kind of ["chat.agent", "chat.createSession"] as const) {
    // Catches: a boot that couldn't read `.out` continuing as a plain run, which doesn't know the
    // reply was handed over and answers its message again from the first step (tools run twice).
    it(`${kind} reads .out again and continues from the next step`, async () => {
      __setApiUnavailableRetryDelaysForTests([1, 1, 1]);
      const t =
        kind === "chat.agent"
          ? gatedAgent("handover.outage-retry")
          : gatedSessionAgent("handover.session-outage-retry", "turn-prepare-step");
      t.release();
      const harness = handedOverRun(t, `handover-outage-retry-${kind}`, [userMessage("go", "u-1")]);
      const reads = outUnreadableFor(2);
      try {
        await waitFor(() => types(harness.allRawChunks).includes("trigger:turn-complete"));

        expect(reads()).toBe(3);
        expect(t.model.doStreamCalls).toHaveLength(1);
        expect(t.toolStarted()).toBe(false);
        expect(harness.allChunks.find((chunk) => chunk.type === "start")).toMatchObject({
          messageId: "a-handed-over",
        });
      } finally {
        __setApiUnavailableRetryDelaysForTests(undefined);
        await harness.close();
      }
    });

    // Catches: the same boot, once the reads have failed for good, answering anything: it fails
    // instead, so no message is answered twice.
    it(`${kind} fails without answering when .out stays unreadable`, async () => {
      __setApiUnavailableRetryDelaysForTests([1, 1]);
      const t =
        kind === "chat.agent"
          ? gatedAgent("handover.outage-fails")
          : gatedSessionAgent("handover.session-outage-fails", "turn-prepare-step");
      t.release();
      const harness = handedOverRun(t, `handover-outage-fails-${kind}`, [userMessage("go", "u-1")]);
      const reads = outUnreadableFor(Number.POSITIVE_INFINITY);
      try {
        await harness.waitForExit(10_000);

        expect(reads()).toBe(3);
        expect(t.model.doStreamCalls).toHaveLength(0);
        expect(t.toolStarted()).toBe(false);
        expect(types(harness.allRawChunks)).not.toContain("trigger:turn-complete");
      } finally {
        __setApiUnavailableRetryDelaysForTests(undefined);
        await harness.close();
      }
    });
  }

  // Catches: chat.agent booting on a handover it read from `.out` without the `.in` tail it can't
  // read, which holds the answered message and what came after: the router would replay them.
  it("chat.agent fails without answering when .in stays unreadable after a handover", async () => {
    __setApiUnavailableRetryDelaysForTests([1, 1]);
    const t = gatedAgent("handover.outage-in-fails");
    t.release();
    const harness = handedOverRun(t, "handover-outage-in-fails", [userMessage("go", "u-1")]);
    let inReads = 0;
    __setReplaySessionInTailImplForTests(async () => {
      inReads++;
      throw new ApiConnectionError({ message: "fetch failed" });
    });
    try {
      await harness.waitForExit(10_000);

      expect(inReads).toBe(3);
      expect(t.model.doStreamCalls).toHaveLength(0);
      expect(types(harness.allRawChunks)).not.toContain("trigger:turn-complete");
    } finally {
      __setApiUnavailableRetryDelaysForTests(undefined);
      await harness.close();
    }
  });
});
