import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import aiPackage from "ai/package.json" with { type: "json" };
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

/**
 * A tool result is history for every later model call. AI SDK versions that do
 * not turn it into plain JSON themselves keep whatever `execute` returned, such
 * as an ORM row's `Date`, and the next call rejects the whole prompt with a
 * positional schema error that names neither the tool nor the field.
 */

const [major = 0, minor = 0, patch = 0] = aiPackage.version.split(/[.-]/).map(Number);
const sdkConvertsToolResults = major > 7 || (major === 7 && (minor > 0 || patch >= 101));

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const userMessage = (text: string, id: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});
const textChunks = (text: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];
const toolCallChunks: LanguageModelV3StreamPart[] = [
  { type: "tool-call", toolCallId: "call_rows", toolName: "rows", input: "{}" },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
];

/** Answers each model call with the next scripted response, then plain text. */
function recordingModel(
  prompts: LanguageModelV3Prompt[],
  script: LanguageModelV3StreamPart[][] = [toolCallChunks]
) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      const chunks = script[call++] ?? textChunks("done");
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function toolOutput(prompt: LanguageModelV3Prompt | undefined, toolCallId: string) {
  return prompt
    ?.flatMap((message) => (message.role === "tool" ? message.content : []))
    .flatMap((part) =>
      part.type === "tool-result" && part.toolCallId === toolCallId ? [part] : []
    )
    .at(0)?.output;
}

async function runTwoTurns(output: () => unknown, chatId: string, steps: number) {
  const prompts: LanguageModelV3Prompt[] = [];
  const model = recordingModel(prompts);
  const agent = chat.agent({
    id: chatId,
    run: async ({ messages, signal }) =>
      streamText({
        ...chat.toStreamTextOptions({
          tools: {
            rows: tool({ inputSchema: z.object({}), execute: async () => output() }),
          },
        }),
        model,
        messages,
        abortSignal: signal,
        stopWhen: stepCountIs(steps),
      }),
  });

  const harness = mockChatAgent(agent, { chatId });
  try {
    await harness.sendMessage(userMessage("list the tasks", "u-1"));
    await harness.sendMessage(userMessage("and now?", "u-2"));
  } finally {
    await harness.close();
  }
  return prompts;
}

const UNSERIALIZABLE = [
  {
    kind: "BigInt",
    output: () => ({ tasks: [{ id: "t1", count: 10n }] }),
    path: "tasks[0].count",
  },
  {
    kind: "circular reference",
    output: () => {
      const task: Record<string, unknown> = { id: "t1" };
      task.self = task;
      return { tasks: [task] };
    },
    path: "tasks[0].self",
  },
];

function expectNamedError(output: unknown, kind: string, path: string) {
  expect(output).toMatchObject({ type: "error-text" });
  const message = (output as { value: string }).value;
  expect(message).toContain('"rows"');
  expect(message).toContain(path);
  expect(message).toContain(kind);
}

describe("tool results in later model calls", () => {
  // Catches: a tool returning a Date (an ORM timestamp column) makes the next
  // model call fail with AI_InvalidPromptError on SDKs that keep the raw value.
  it("carries a Date as its JSON string", { timeout: 30_000 }, async () => {
    const prompts = await runTwoTurns(
      () => ({ tasks: [{ id: "t1", statusChangedAt: new Date("2026-01-02T03:04:05.000Z") }] }),
      "tool-output-json-date",
      3
    );

    expect(prompts).toHaveLength(3);
    expect(toolOutput(prompts[2], "call_rows")).toEqual({
      type: "json",
      value: { tasks: [{ id: "t1", statusChangedAt: "2026-01-02T03:04:05.000Z" }] },
    });
  });

  // Catches: an object referenced twice (an ORM row's owner and assignee being
  // the same user) taken for a circular reference and replaced by an error.
  it("carries an object referenced twice in both places", { timeout: 30_000 }, async () => {
    const prompts = await runTwoTurns(
      () => {
        const user = { id: "u1", joinedAt: new Date("2026-01-02T03:04:05.000Z") };
        return { tasks: [{ id: "t1", owner: user, assignee: user }] };
      },
      "tool-output-json-shared",
      3
    );

    const user = { id: "u1", joinedAt: "2026-01-02T03:04:05.000Z" };
    expect(toolOutput(prompts[2], "call_rows")).toEqual({
      type: "json",
      value: { tasks: [{ id: "t1", owner: user, assignee: user }] },
    });
  });

  // Catches: a value JSON cannot hold leaves later calls failing with an error
  // that names neither the tool nor the field. From 7.0.101 the AI SDK converts
  // the result itself and fails the call that produced it, so this is ours to
  // report only before that.
  it.skipIf(sdkConvertsToolResults).each(UNSERIALIZABLE)(
    "replaces a result holding a $kind with an error naming the tool and field",
    { timeout: 30_000 },
    async ({ kind, output, path }) => {
      const prompts = await runTwoTurns(output, `tool-output-json-${kind.replace(/ /g, "-")}`, 1);

      expect(prompts).toHaveLength(2);
      expectNamedError(toolOutput(prompts[1], "call_rows"), kind, path);
    }
  );
});

describe("tool results in the next step of the same call", () => {
  // Catches: on AI SDK 7 before 7.0.101 every step re-checks its prompt, so a
  // tool's Date fails the step right after it with AI_InvalidPromptError.
  it("carries a Date as its JSON string", { timeout: 30_000 }, async () => {
    const prompts = await runTwoTurns(
      () => ({ tasks: [{ id: "t1", statusChangedAt: new Date("2026-01-02T03:04:05.000Z") }] }),
      "tool-output-json-step-date",
      3
    );

    expect(prompts[1]?.at(-1)?.role).toBe("tool");
    expect(toolOutput(prompts[1], "call_rows")).toEqual({
      type: "json",
      value: { tasks: [{ id: "t1", statusChangedAt: "2026-01-02T03:04:05.000Z" }] },
    });
  });

  // Catches: a value JSON cannot hold reaching the next step, where the provider
  // request fails on it without naming the tool.
  it.skipIf(sdkConvertsToolResults).each(UNSERIALIZABLE)(
    "replaces a result holding a $kind with an error naming the tool and field",
    { timeout: 30_000 },
    async ({ kind, output, path }) => {
      const prompts = await runTwoTurns(
        output,
        `tool-output-json-step-${kind.replace(/ /g, "-")}`,
        3
      );

      expect(prompts[1]?.at(-1)?.role).toBe("tool");
      expectNamedError(toolOutput(prompts[1], "call_rows"), kind, path);
    }
  );
});

describe("tool results across several steps of the same call", () => {
  // Catches: a result holding a value JSON cannot hold (a BigInt, a circular
  // reference) crashing the step after the next one, when the steps already
  // sent are compared with the new ones, so the model call never runs.
  it.skipIf(sdkConvertsToolResults).each(UNSERIALIZABLE)(
    "runs the third model call after a result holding a $kind",
    { timeout: 30_000 },
    async ({ kind, output, path }) => {
      const secondCall: LanguageModelV3StreamPart[] = [
        { type: "tool-call", toolCallId: "call_rows_2", toolName: "rows", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
      ];
      const prompts: LanguageModelV3Prompt[] = [];
      const model = recordingModel(prompts, [toolCallChunks, secondCall]);
      const id = `tool-output-json-steps-${kind.replace(/ /g, "-")}`;
      const agent = chat.agent({
        id,
        run: async ({ messages, signal }) =>
          streamText({
            ...chat.toStreamTextOptions({
              tools: {
                rows: tool({ inputSchema: z.object({}), execute: async () => output() }),
              },
            }),
            model,
            messages,
            abortSignal: signal,
            stopWhen: stepCountIs(4),
          }),
      });

      const harness = mockChatAgent(agent, { chatId: id });
      try {
        await harness.sendMessage(userMessage("list the tasks", "u-1"));
      } finally {
        await harness.close();
      }

      expect(prompts).toHaveLength(3);
      expectNamedError(toolOutput(prompts[2], "call_rows"), kind, path);
      expectNamedError(toolOutput(prompts[2], "call_rows_2"), kind, path);
    }
  );
});

describe("tool results from separate calls returning the same object", () => {
  // Catches: a tool returning one shared state object, updated between calls,
  // sending the model the first call's snapshot for every later call.
  it("gives each call the value it returned", { timeout: 30_000 }, async () => {
    const callChunks = (toolCallId: string): LanguageModelV3StreamPart[] => [
      { type: "tool-call", toolCallId, toolName: "counter", input: "{}" },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
    ];
    const prompts: LanguageModelV3Prompt[] = [];
    const model = recordingModel(prompts, [callChunks("call_a"), callChunks("call_b")]);
    const state = { count: 0, updatedAt: new Date(0) };
    const agent = chat.agent({
      id: "tool-output-json-shared-state",
      run: async ({ messages, signal }) =>
        streamText({
          ...chat.toStreamTextOptions({
            tools: {
              counter: tool({
                inputSchema: z.object({}),
                execute: async () => {
                  state.count += 1;
                  state.updatedAt = new Date(state.count * 1000);
                  return state;
                },
              }),
            },
          }),
          model,
          messages,
          abortSignal: signal,
          stopWhen: stepCountIs(3),
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "tool-output-json-shared-state" });
    try {
      await harness.sendMessage(userMessage("count twice", "u-1"));
      await harness.sendMessage(userMessage("and now?", "u-2"));
    } finally {
      await harness.close();
    }

    // The step after the second call: each call keeps the value it returned.
    expect(prompts).toHaveLength(4);
    const afterSecondCall = prompts[2];
    expect(afterSecondCall?.at(-1)?.role).toBe("tool");
    expect(toolOutput(afterSecondCall, "call_a")).toEqual({
      type: "json",
      value: { count: 1, updatedAt: new Date(1000).toISOString() },
    });
    expect(toolOutput(afterSecondCall, "call_b")).toEqual({
      type: "json",
      value: { count: 2, updatedAt: new Date(2000).toISOString() },
    });
  });
});

describe("a BigInt in an app that defines BigInt.prototype.toJSON", () => {
  // Catches: every BigInt reported as unserializable, so a tool returning an
  // ORM row with a BigInt id (an app that defines BigInt.prototype.toJSON, where
  // JSON.stringify gives "1") got an error result instead of its value.
  it("carries the value toJSON gives, in later model calls and in the next step", async () => {
    const bigint = BigInt.prototype as { toJSON?: () => string };
    bigint.toJSON = function (this: bigint) {
      return String(this);
    };
    try {
      for (const steps of [1, 3]) {
        const prompts = await runTwoTurns(
          () => ({ id: 1n }),
          `tool-output-json-bigint-${steps}`,
          steps
        );
        expect(toolOutput(prompts[1], "call_rows")).toEqual({ type: "json", value: { id: "1" } });
      }
    } finally {
      delete bigint.toJSON;
    }
  });
});
