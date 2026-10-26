import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { TranscriptSnapshotV2 } from "@trigger.dev/core/v3";
import {
  simulateReadableStream,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";
import { convertSteeredMessages, steeringMarkers } from "../src/v3/steeringContext.js";

/**
 * `chat.inject` called from a tool's `execute` reaches the model at the next
 * step boundary, after the tool result. Saved history must keep it there, or
 * the next turn's prompt prefix differs from what the model already saw.
 */

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function userMessage(text: string, id: string) {
  return { id, role: "user" as const, parts: [{ type: "text" as const, text }] };
}

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

function toolCallChunks(callId: string, toolName: string): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId: callId, toolName, input: JSON.stringify({}) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
  ];
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Snapshot once it holds an assistant, written after the turn ends. */
async function settledSnapshot(harness: { getSnapshot(): TranscriptSnapshotV2 | undefined }) {
  await waitFor(
    () => !!harness.getSnapshot()?.messages.some((e) => e.message.role === "assistant"),
    "snapshot with the response"
  );
  return structuredClone(harness.getSnapshot()!);
}

/** Replies follow `script` by call index, then fall back to "Done". */
function scriptedModel(script: Array<LanguageModelV3StreamPart[]>) {
  const prompts: ModelMessage[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const chunks = script[prompts.length] ?? textChunks("Done");
      prompts.push(JSON.parse(JSON.stringify(prompt)));
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: 5, chunkDelayInMs: 1 }),
      };
    },
  });
  return { model, prompts };
}

const workTool = tool({
  description: "does work and injects a reminder",
  inputSchema: z.object({}),
  execute: async () => {
    chat.inject([{ role: "user", content: "REMINDER" }]);
    return "WORK_RESULT";
  },
});

const noopTool = tool({
  description: "does nothing",
  inputSchema: z.object({}),
  execute: async () => "NOOP_RESULT",
});

type Shape = { role: string; text: string };

/** Role plus the texts a message carries, for order assertions. */
function shape(messages: ModelMessage[]): Shape[] {
  return messages.map((m) => {
    const content = m.content as unknown;
    if (typeof content === "string") return { role: m.role, text: content };
    const texts = (content as Array<Record<string, any>>).map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "tool-call") return `call:${c.toolName}`;
      if (c.type === "tool-result") return `result:${JSON.stringify(c.output)}`;
      return c.type;
    });
    return { role: m.role, text: texts.join("|") };
  });
}

function makeAgent(
  id: string,
  model: MockLanguageModelV3,
  lanes: ModelMessage[][],
  extra: Partial<Parameters<typeof chat.agent>[0]> = {},
  slowConsumer = false
) {
  return chat.agent({
    id,
    onTurnComplete: async ({ messages }) => {
      lanes.push(JSON.parse(JSON.stringify(messages)));
    },
    run: async ({ messages, signal }) =>
      streamText({
        model,
        messages,
        abortSignal: signal,
        ...chat.toStreamTextOptions(),
        tools: { work: workTool, noop: noopTool },
        stopWhen: stepCountIs(5),
        ...(slowConsumer ? { experimental_transform: slowTransform } : {}),
      }),
    ...extra,
  } as Parameters<typeof chat.agent>[0]);
}

/**
 * Lets the next step's prepareStep run before the UI stream has reached the
 * previous step's finish-step.
 */
const slowTransform = () =>
  new TransformStream({
    async transform(chunk, controller) {
      await new Promise((r) => setTimeout(r, 5));
      controller.enqueue(chunk);
    },
  });

const finishStepIndexes = (types: string[]) =>
  types.flatMap((type, i) => (type === "finish-step" ? [i] : []));

describe("chat.inject from a tool mid-turn", () => {
  it("keeps the injection after the tool result in the next turn's prompt", async () => {
    const { model, prompts } = scriptedModel([toolCallChunks("tc-1", "work")]);
    const lanes: ModelMessage[][] = [];
    const harness = mockChatAgent(makeAgent("bg-inject-order", model, lanes), {
      chatId: "bg-inject-order",
    });
    try {
      await harness.sendMessage(userMessage("go", "u-1"));
      await harness.sendMessage(userMessage("again", "u-2"));

      expect(prompts).toHaveLength(3);
      const turn1 = shape(prompts[1]!);
      expect(turn1).toEqual([
        { role: "user", text: "go" },
        { role: "assistant", text: "call:work" },
        { role: "tool", text: expect.stringContaining("WORK_RESULT") },
        { role: "user", text: "REMINDER" },
      ]);
      const turn2 = shape(prompts[2]!);
      expect(turn2.slice(0, turn1.length)).toEqual(turn1);
      expect(turn2.slice(turn1.length)).toEqual([
        { role: "assistant", text: "Done" },
        { role: "user", text: "again" },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("writes a background marker after the tool result, before the next step", async () => {
    const { model } = scriptedModel([toolCallChunks("tc-1", "work")]);
    const harness = mockChatAgent(makeAgent("bg-inject-marker", model, [], {}, true), {
      chatId: "bg-inject-marker",
    });
    try {
      const turn = await harness.sendMessage(userMessage("go", "u-1"));
      // On the wire the marker follows the tool step's finish-step.
      const wire = turn.chunks.map((c) => c.type);
      expect(wire.indexOf("data-background-injected")).toBe(wire.indexOf("finish-step") + 1);
      // Older chat clients render every pending-message marker; this must not be one.
      expect(wire).not.toContain("data-pending-message-injected");

      const assistant = (await settledSnapshot(harness)).messages
        .map((e) => e.message)
        .find((m) => m.role === "assistant");
      const types = assistant!.parts.map((p) => p.type);
      const toolIdx = types.indexOf("tool-work");
      const markerIdx = types.indexOf("data-background-injected");
      const nextStepIdx = types.indexOf("step-start", toolIdx);
      expect(toolIdx).toBeGreaterThan(-1);
      expect(markerIdx).toBeGreaterThan(toolIdx);
      expect(markerIdx).toBeLessThan(nextStepIdx);
      expect((assistant!.parts[toolIdx] as { state?: string }).state).toBe("output-available");
      expect(assistant!.parts[markerIdx]).toEqual({
        type: "data-background-injected",
        id: expect.any(String),
        data: { messageIds: [], messages: [] },
      });
    } finally {
      await harness.close();
    }
  });

  it("rebuilds the same model lane when a new run boots from the snapshot", async () => {
    const { model } = scriptedModel([toolCallChunks("tc-1", "work")]);
    const lanes: ModelMessage[][] = [];
    const harness = mockChatAgent(makeAgent("bg-inject-restore", model, lanes), {
      chatId: "bg-inject-restore",
    });
    let snapshot: TranscriptSnapshotV2 | undefined;
    try {
      await harness.sendMessage(userMessage("go", "u-1"));
      snapshot = await settledSnapshot(harness);
    } finally {
      await harness.close();
    }
    const turn1Lane = shape(lanes[0]!);
    expect(turn1Lane.map((m) => m.text)).toContain("REMINDER");

    const restored = scriptedModel([]);
    const restoredHarness = mockChatAgent(makeAgent("bg-inject-restore", restored.model, []), {
      chatId: "bg-inject-restore",
      snapshot,
      continuation: true,
      previousRunId: "run_prior",
    });
    try {
      await restoredHarness.sendMessage(userMessage("again", "u-2"));
      const prompt = shape(restored.prompts[0]!);
      expect(prompt).toEqual([...turn1Lane, { role: "user", text: "again" }]);
    } finally {
      await restoredHarness.close();
    }
  });

  it("keeps the marker and its entry when compaction runs after the injection", async () => {
    const { model, prompts } = scriptedModel([
      toolCallChunks("tc-1", "work"),
      toolCallChunks("tc-2", "noop"),
      toolCallChunks("tc-3", "noop"),
    ]);
    let compacted = 0;
    const lanes: ModelMessage[][] = [];
    const agent = makeAgent("bg-inject-compaction", model, lanes, {
      compaction: {
        shouldCompact: ({ steps }: { steps?: unknown[] }) =>
          compacted === 0 && (steps?.length ?? 0) >= 2,
        summarize: async () => {
          compacted++;
          return "SUMMARY";
        },
      },
    } as never);
    const harness = mockChatAgent(agent, { chatId: "bg-inject-compaction" });
    let snapshot: TranscriptSnapshotV2 | undefined;
    try {
      await harness.sendMessage(userMessage("go", "u-1"));
      expect(compacted).toBe(1);
      snapshot = await settledSnapshot(harness);
      await harness.sendMessage(userMessage("again", "u-2"));
    } finally {
      await harness.close();
    }

    const transcript = snapshot!.messages.map((e) => e.message);
    const markers = steeringMarkers(transcript);
    expect(markers).toEqual([expect.objectContaining({ kind: "background", messageIds: [] })]);
    const state = snapshot!.state as { steering?: Array<{ id: string; kind?: string }> };
    expect(state.steering).toEqual([
      expect.objectContaining({ id: markers[0]!.id, kind: "background" }),
    ]);

    // Every tool call the next turn sends still has its result.
    const turn2 = prompts.at(-1)!;
    const calls = turn2.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; toolCallId?: string }>)
            .filter((c) => c.type === "tool-call")
            .map((c) => c.toolCallId)
        : []
    );
    const results = turn2.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; toolCallId?: string }>)
            .filter((c) => c.type === "tool-result")
            .map((c) => c.toolCallId)
        : []
    );
    expect(calls).toEqual(["tc-3"]);
    expect(results).toEqual(calls);
    expect(JSON.stringify(turn2)).toContain("SUMMARY");

    const restored = scriptedModel([]);
    const restoredHarness = mockChatAgent(
      makeAgent("bg-inject-compaction", restored.model, [], {
        compaction: { shouldCompact: () => false, summarize: async () => "unused" },
      } as never),
      {
        chatId: "bg-inject-compaction",
        snapshot,
        continuation: true,
        previousRunId: "run_prior",
      }
    );
    try {
      await restoredHarness.sendMessage(userMessage("again", "u-2"));
      expect(shape(restored.prompts[0]!)).toEqual(shape(turn2));
    } finally {
      await restoredHarness.close();
    }
  });
});

describe("chat.inject marker placement across generations", () => {
  it("places the marker against the second generation of a turn", async () => {
    const first = scriptedModel([textChunks("First")]);
    const second = scriptedModel([toolCallChunks("tc-1", "work")]);
    const agent = chat.agent({
      id: "bg-inject-two-generations",
      run: async ({ messages, signal }) => {
        await chat.pipeAndCapture(
          streamText({
            model: first.model,
            messages,
            abortSignal: signal,
            ...chat.toStreamTextOptions(),
            experimental_transform: slowTransform,
          })
        );
        await chat.pipeAndCapture(
          streamText({
            model: second.model,
            messages,
            abortSignal: signal,
            ...chat.toStreamTextOptions(),
            tools: { work: workTool },
            stopWhen: stepCountIs(5),
            experimental_transform: slowTransform,
          })
        );
      },
    });
    const harness = mockChatAgent(agent, { chatId: "bg-inject-two-generations" });
    try {
      const turn = await harness.sendMessage(userMessage("go", "u-1"));
      const wire = turn.chunks.map((c) => c.type);
      // Generation 1 has one step; the marker follows generation 2's tool step.
      expect(wire.indexOf("data-background-injected")).toBe(finishStepIndexes(wire)[1]! + 1);
    } finally {
      await harness.close();
    }
  });

  it("places the marker against a generation consumed before it is piped", async () => {
    const first = scriptedModel([textChunks("First")]);
    const second = scriptedModel([toolCallChunks("tc-1", "work")]);
    const agent = chat.agent({
      id: "bg-inject-delayed-pipe",
      run: async ({ messages, signal }) => {
        await chat.pipeAndCapture(
          streamText({
            model: first.model,
            messages,
            abortSignal: signal,
            ...chat.toStreamTextOptions(),
          })
        );
        const result = streamText({
          model: second.model,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions(),
          tools: { work: workTool },
          stopWhen: stepCountIs(5),
        });
        await result.text;
        await chat.pipeAndCapture(result);
      },
    });
    const harness = mockChatAgent(agent, { chatId: "bg-inject-delayed-pipe" });
    try {
      const turn = await harness.sendMessage(userMessage("go", "u-1"));
      const wire = turn.chunks.map((c) => c.type);
      expect(wire.indexOf("data-background-injected")).toBe(finishStepIndexes(wire)[1]! + 1);
    } finally {
      await harness.close();
    }
  });

  it("places the marker at the outer step when a tool runs a nested generation", async () => {
    const inner = scriptedModel([textChunks("inner")]);
    const nestedTool = tool({
      description: "runs a nested generation, then injects",
      inputSchema: z.object({}),
      execute: async () => {
        const result = streamText({
          model: inner.model,
          prompt: "inner work",
          ...chat.toStreamTextOptions(),
        });
        await result.text;
        chat.inject([{ role: "user", content: "REMINDER" }]);
        return "NESTED_RESULT";
      },
    });
    const outer = scriptedModel([toolCallChunks("tc-1", "noop"), toolCallChunks("tc-2", "nested")]);
    const agent = chat.agent({
      id: "bg-inject-nested",
      run: async ({ messages, signal }) =>
        streamText({
          model: outer.model,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions(),
          tools: { noop: noopTool, nested: nestedTool },
          stopWhen: stepCountIs(5),
        }),
    });
    const harness = mockChatAgent(agent, { chatId: "bg-inject-nested" });
    try {
      const turn = await harness.sendMessage(userMessage("go", "u-1"));
      expect(inner.prompts).toHaveLength(1);
      const wire = turn.chunks.map((c) => c.type);
      // Outer steps: noop, nested, then the answer. The marker follows step 2.
      expect(finishStepIndexes(wire)).toHaveLength(3);
      expect(wire.indexOf("data-background-injected")).toBe(finishStepIndexes(wire)[1]! + 1);
    } finally {
      await harness.close();
    }
  });
});

describe("steeringMarkers", () => {
  it("reads the pending-message type as steering and the background type as background", () => {
    const markers = steeringMarkers([
      {
        id: "a-1",
        role: "assistant",
        parts: [
          {
            type: "data-pending-message-injected",
            id: "m-old",
            data: { messageIds: ["u-2"], messages: [{ id: "u-2", text: "steer" }] },
          } as never,
          {
            type: "data-background-injected",
            id: "m-bg",
            data: { messageIds: [], messages: [] },
          } as never,
        ],
      },
    ]);
    expect(markers.map((m) => [m.id, m.kind])).toEqual([
      ["m-old", "steering"],
      ["m-bg", "background"],
    ]);
  });
});

describe("injection markers outside assistant messages", () => {
  const marker = (id: string, messageIds: string[]) =>
    ({ type: "data-pending-message-injected", id, data: { messageIds, messages: [] } }) as never;

  it("keeps the messages a user-message marker names in the rebuilt lane", async () => {
    const messages = [
      { id: "u-1", role: "user" as const, parts: [{ type: "text" as const, text: "go" }] },
      {
        id: "a-1",
        role: "assistant" as const,
        parts: [
          { type: "text" as const, text: "before" },
          {
            type: "data-background-injected",
            id: "m-bg",
            data: { messageIds: [], messages: [] },
          } as never,
          { type: "text" as const, text: "after" },
        ],
      },
      {
        id: "u-2",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "next" }, marker("m-user", ["a-1", "u-1"])],
      },
    ];
    const out = await convertSteeredMessages(
      messages,
      async (batch) =>
        batch.map((m) => ({ role: m.role, content: m.id }) as unknown as ModelMessage),
      new Map([
        [
          "m-bg",
          {
            id: "m-bg",
            messageIds: [],
            messages: [{ role: "user" as const, content: "REMINDER" }],
            kind: "background" as const,
          },
        ],
      ])
    );
    expect(out).toEqual([
      { role: "user", content: "u-1" },
      { role: "assistant", content: "a-1" },
      { role: "user", content: "REMINDER" },
      { role: "assistant", content: "a-1" },
      { role: "user", content: "u-2" },
    ]);
    expect(steeringMarkers(messages).map((m) => m.id)).toEqual(["m-bg"]);
  });

  it("drops marker parts from an incoming assistant message with a new id", async () => {
    const { model, prompts } = scriptedModel([toolCallChunks("tc-1", "work")]);
    const harness = mockChatAgent(makeAgent("marker-in-new-assistant", model, []), {
      chatId: "marker-in-new-assistant",
    });
    try {
      await harness.sendMessage(userMessage("go", "u-1"));
      const first = await settledSnapshot(harness);
      const [existing] = steeringMarkers(first.messages.map((e) => e.message));
      expect(existing?.kind).toBe("background");

      await harness.sendMessage({
        id: "a-client",
        role: "assistant",
        parts: [
          { type: "text", text: "client text" },
          {
            type: "data-background-injected",
            id: existing!.id,
            data: { messageIds: [], messages: [] },
          } as never,
        ],
      });
      await waitFor(
        () => !!harness.getSnapshot()?.messages.some((e) => e.id === "a-client"),
        "client message saved"
      );
      const saved = harness.getSnapshot()!.messages.map((e) => e.message);
      expect(saved.find((m) => m.id === "a-client")?.parts.map((p) => p.type)).toEqual(["text"]);
      const lane = JSON.stringify(prompts.at(-1));
      expect(lane.split("REMINDER").length - 1).toBe(1);
    } finally {
      await harness.close();
    }
  });

  describe("on a tool continuation of a stored assistant message", () => {
    const askTool = tool({
      description: "answered by the client",
      inputSchema: z.object({}),
      outputSchema: z.string(),
    });

    async function continueWith(
      chatId: string,
      edit: (parts: UIMessage["parts"], markerId: string) => UIMessage["parts"]
    ) {
      const { model, prompts } = scriptedModel([
        toolCallChunks("tc-1", "work"),
        toolCallChunks("tc-2", "ask"),
      ]);
      const agent = chat.agent({
        id: chatId,
        run: async ({ messages, signal }) =>
          streamText({
            model,
            messages,
            abortSignal: signal,
            ...chat.toStreamTextOptions(),
            tools: { work: workTool, ask: askTool },
            stopWhen: stepCountIs(5),
          }),
      });
      const harness = mockChatAgent(agent, { chatId });
      try {
        await harness.sendMessage(userMessage("go", "u-1"));
        const stored = (await settledSnapshot(harness)).messages
          .map((e) => e.message)
          .find((m) => m.role === "assistant")!;
        const markerId = steeringMarkers([stored])[0]!.id;
        const answered = stored.parts.map((p) =>
          p.type === "tool-ask"
            ? ({ ...p, state: "output-available", output: "yes" } as UIMessage["parts"][number])
            : p
        );
        await harness.sendMessage({ ...stored, parts: edit(answered, markerId) });
        await waitFor(
          () =>
            !!harness
              .getSnapshot()
              ?.messages.some((e) =>
                e.message.parts.some((p) => p.type === "text" && p.text === "Done")
              ),
          "continuation saved"
        );
        const saved = harness.getSnapshot()!.messages.find((e) => e.id === stored.id)!.message;
        return { stored, saved, lane: JSON.stringify(prompts.at(-1)) };
      } finally {
        await harness.close();
      }
    }

    const markerPositions = (message: UIMessage) =>
      message.parts.flatMap((p, i) =>
        p.type === "data-background-injected" ? [[i, (p as { id?: string }).id]] : []
      );

    it("keeps the stored markers when the client adds one", async () => {
      const { stored, saved, lane } = await continueWith("hitl-extra-marker", (parts, id) => [
        { type: "data-background-injected", id, data: { messageIds: [], messages: [] } } as never,
        ...parts,
      ]);
      expect(markerPositions(saved).slice(0, 1)).toEqual(markerPositions(stored));
      expect(markerPositions(saved)).toHaveLength(1);
      expect(lane.split("REMINDER").length - 1).toBe(1);
    });

    it("keeps the stored markers when the client omits them", async () => {
      const { stored, saved, lane } = await continueWith("hitl-no-marker", (parts) =>
        parts.filter((p) => p.type !== "data-background-injected")
      );
      expect(markerPositions(saved).slice(0, 1)).toEqual(markerPositions(stored));
      expect(markerPositions(saved)).toHaveLength(1);
      expect(lane.split("REMINDER").length - 1).toBe(1);
    });
  });

  it("drops marker parts from an incoming user message when a pre-run hook throws", async () => {
    const { model } = scriptedModel([]);
    const completed: UIMessage[][] = [];
    const agent = chat.agent({
      id: "marker-in-user-message-error",
      onValidateMessages: async () => {
        throw new Error("validation failed");
      },
      onTurnComplete: async ({ newUIMessages }) => {
        completed.push(newUIMessages);
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "marker-in-user-message-error" });
    try {
      await harness.sendMessage({
        ...userMessage("go", "u-1"),
        parts: [{ type: "text", text: "go" }, marker("m-user", [])],
      });
      await waitFor(() => completed.length === 1, "error turn completed");
      await waitFor(
        () => !!harness.getSnapshot()?.messages.some((e) => e.id === "u-1"),
        "error turn saved"
      );
      const saved = harness.getSnapshot()!.messages.find((e) => e.id === "u-1")!.message;
      expect(saved.parts.map((p) => p.type)).toEqual(["text"]);
      expect(completed[0]!.find((m) => m.id === "u-1")?.parts.map((p) => p.type)).toEqual(["text"]);
    } finally {
      await harness.close();
    }
  });

  it("drops marker parts from an incoming user message", async () => {
    const { model } = scriptedModel([]);
    const harness = mockChatAgent(makeAgent("marker-in-user-message", model, []), {
      chatId: "marker-in-user-message",
    });
    try {
      await harness.sendMessage(userMessage("go", "u-1"));
      await harness.sendMessage({
        ...userMessage("again", "u-2"),
        parts: [{ type: "text", text: "again" }, marker("m-user", ["u-1"])],
      });
      await waitFor(
        () => !!harness.getSnapshot()?.messages.some((e) => e.id === "u-2"),
        "second turn saved"
      );
      const saved = harness.getSnapshot()!.messages.map((e) => e.message);
      expect(saved.find((m) => m.id === "u-2")?.parts.map((p) => p.type)).toEqual(["text"]);
      expect(saved.map((m) => m.id)).toContain("u-1");
    } finally {
      await harness.close();
    }
  });
});
