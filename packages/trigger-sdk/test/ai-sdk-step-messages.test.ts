import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ModelMessage, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { retainStepMessages } from "../src/v3/steeringContext.js";
import { withToolResultsInCallOrder } from "../src/v3/toolResultOrder.js";
import { aiSdks, type AiSdk } from "./aiSdkVersions.js";

/**
 * Every prepareStep the SDK hands to streamText (steering, compaction,
 * chat.inject, tool results in call order, a caller's own) is wrapped in
 * retainStepMessages. These run that wrapper through each installed AI SDK
 * major's real step loop, since what a step's input and response hold differs
 * between majors.
 */

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const toolName = (id: string) => id.split("-")[0]!;

const answer: LanguageModelV3StreamPart[] = [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "done" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
];

const user = (text: string): ModelMessage => ({ role: "user", content: text });

type Prepare = (input: {
  messages: ModelMessage[];
  stepNumber: number;
}) => Promise<{ messages: ModelMessage[] } | undefined>;

/**
 * Runs one generation where model call `i` makes the tool calls `calls[i]`,
 * and the call after the last answers. Returns the prompt of every call.
 */
async function generate(
  sdk: AiSdk,
  calls: string[][],
  prepare: Prepare
): Promise<LanguageModelV3Prompt[]> {
  const prompts: LanguageModelV3Prompt[] = [];
  const model = sdk.mockModel(async ({ prompt }) => {
    prompts.push(prompt);
    const ids = calls[prompts.length - 1];
    const chunks: LanguageModelV3StreamPart[] = ids
      ? [
          ...ids.map((id): LanguageModelV3StreamPart => ({
            type: "tool-call",
            toolCallId: id,
            toolName: toolName(id),
            input: "{}",
          })),
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
        ]
      : answer;
    return { stream: sdk.simulateReadableStream({ chunks }) };
  });
  const delayed = (ms: number) =>
    sdk.tool({
      inputSchema: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { ms };
      },
    });

  const result = sdk.streamText({
    model,
    messages: [user("hi")],
    tools: { lookup: delayed(0), slow: delayed(30), fast: delayed(1) },
    stopWhen: sdk.stepCountIs(calls.length + 1),
    prepareStep: retainStepMessages(prepare as never),
  });
  await result.consumeStream();
  return prompts;
}

const toolResults = (prompt: LanguageModelV3Prompt) =>
  prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
      : []
  );

const userTexts = (prompt: LanguageModelV3Prompt) =>
  prompt.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : []
  );

describe.each(aiSdks.map((sdk) => ({ ...sdk, name: `AI SDK ${sdk.major}` })))(
  "step input under a wrapped prepareStep on $name",
  (sdk) => {
    const lookups = [["lookup-1"], ["lookup-2"], ["lookup-3"]];

    // Catches: once one step's prepareStep returns messages (a steer, an
    // injection, a compaction), every later step's input freezes on an AI SDK
    // whose step response holds only that step's messages, so the model never
    // sees its newer tool results and repeats the same call until the step cap.
    it("keeps adding each step's tool results after an override on the first step", async () => {
      const prompts = await generate(sdk, lookups, async ({ messages, stepNumber }) =>
        stepNumber === 0 ? { messages: [...messages, user("steer")] } : undefined
      );

      expect(prompts.map(toolResults)).toEqual([
        [],
        ["lookup-1"],
        ["lookup-1", "lookup-2"],
        ["lookup-1", "lookup-2", "lookup-3"],
      ]);
      for (const prompt of prompts) expect(userTexts(prompt)).toEqual(["hi", "steer"]);
    });

    // Catches: an override on every step (steering drained step after step)
    // keeps the overrides but drops the tool results in between.
    it("keeps every override and every tool result when each step overrides", async () => {
      const prompts = await generate(sdk, lookups, async ({ messages, stepNumber }) => ({
        messages: [...messages, user(`steer ${stepNumber}`)],
      }));

      expect(prompts.map(toolResults)).toEqual([
        [],
        ["lookup-1"],
        ["lookup-1", "lookup-2"],
        ["lookup-1", "lookup-2", "lookup-3"],
      ]);
      expect(prompts.map(userTexts)).toEqual([
        ["hi", "steer 0"],
        ["hi", "steer 0", "steer 1"],
        ["hi", "steer 0", "steer 1", "steer 2"],
        ["hi", "steer 0", "steer 1", "steer 2", "steer 3"],
      ]);
    });

    // Catches: after a compaction between steps, later steps either lose the
    // tool results that follow the summary or bring back what it replaced.
    it("builds on a compaction summary with the tool results that follow it", async () => {
      const prompts = await generate(sdk, lookups, async ({ stepNumber }) =>
        stepNumber === 2 ? { messages: [user("summary")] } : undefined
      );

      expect(prompts.slice(2).map(toolResults)).toEqual([[], ["lookup-3"]]);
      expect(prompts.slice(2).map(userTexts)).toEqual([["summary"], ["summary"]]);
    });

    // Catches: parallel tool results reaching the model in finish order, or
    // dropping out of later steps. Where the AI SDK hands them over in finish
    // order, putting them back in call order is itself an override, and a
    // later step's input must still grow; where it already uses call order,
    // nothing is overridden and they must still arrive in that order.
    it("keeps parallel tool results in call order across steps", async () => {
      const prompts = await generate(
        sdk,
        [["slow-1", "fast-1"], ["slow-2", "fast-2"], ["lookup-3"]],
        async ({ messages }) => {
          const ordered = withToolResultsInCallOrder(messages);
          return ordered !== messages ? { messages: ordered } : undefined;
        }
      );

      expect(prompts.map(toolResults)).toEqual([
        [],
        ["slow-1", "fast-1"],
        ["slow-1", "fast-1", "slow-2", "fast-2"],
        ["slow-1", "fast-1", "slow-2", "fast-2", "lookup-3"],
      ]);
    });

    // Catches: a model that repeats the same call, with the same tool call id
    // and the same result, on consecutive steps. Two identical steps can look
    // like one step's messages carried into the next, and reading them that
    // way drops the newest step: its result never reaches the model, which
    // repeats the call until the step cap.
    it("keeps each step's results when the model repeats the same call", async () => {
      const prompts = await generate(
        sdk,
        [["lookup-1"], ["lookup-1"], ["lookup-1"]],
        async ({ messages, stepNumber }) =>
          stepNumber === 0 ? { messages: [...messages, user("steer")] } : undefined
      );

      expect(prompts.map((prompt) => toolResults(prompt).length)).toEqual([0, 1, 2, 3]);
    });

    // Catches: a step that adds no message while a provider-executed tool's
    // deferred result is pending. Up to AI SDK 6 that step's response messages
    // are the same as the step before, and reading them as new sends the
    // earlier tool call to the model a second time.
    it("adds nothing for a step that only waits on a deferred provider tool", async () => {
      const prompts: LanguageModelV3Prompt[] = [];
      const finish = (unified: "tool-calls" | "stop"): LanguageModelV3StreamPart => ({
        type: "finish",
        finishReason: { unified, raw: unified },
        usage,
      });
      const steps: LanguageModelV3StreamPart[][] = [
        [
          {
            type: "tool-call",
            toolCallId: "search-1",
            toolName: "search",
            input: "{}",
            providerExecuted: true,
          },
          finish("tool-calls"),
        ],
        [finish("tool-calls")],
        answer,
      ];
      const model = sdk.mockModel(async ({ prompt }) => {
        prompts.push(prompt);
        return {
          stream: sdk.simulateReadableStream({ chunks: steps[prompts.length - 1] ?? answer }),
        };
      });
      const search = {
        type: "provider" as const,
        id: "test.search" as const,
        args: {},
        inputSchema: z.object({}),
        supportsDeferredResults: true,
      };

      const result = sdk.streamText({
        model,
        messages: [user("hi")],
        tools: { search } as unknown as ToolSet,
        stopWhen: sdk.stepCountIs(3),
        prepareStep: retainStepMessages((async ({
          messages,
          stepNumber,
        }: {
          messages: ModelMessage[];
          stepNumber: number;
        }) =>
          stepNumber === 0 ? { messages: [...messages, user("steer")] } : undefined) as never),
      });
      await result.consumeStream();

      expect(prompts.length).toBeGreaterThanOrEqual(3);
      for (const prompt of prompts) {
        const calls = prompt.flatMap((message) =>
          message.role === "assistant" && typeof message.content !== "string"
            ? message.content.flatMap((part) =>
                part.type === "tool-call" ? [part.toolCallId] : []
              )
            : []
        );
        expect(calls, "a tool call is sent twice").toEqual([...new Set(calls)]);
      }
    });
  }
);
