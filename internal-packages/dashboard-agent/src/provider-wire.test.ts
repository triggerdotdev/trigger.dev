import { createBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, generateText, tool, type LanguageModel, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { prepareTurnMessages } from "./dashboard-agent";

/**
 * What a wake turn puts on the wire. It keeps the turn's tools declared and asks for
 * `toolChoice: "none"`, so a model with preserved thinking sees the same tool list it
 * bound earlier reasoning to. `@ai-sdk/anthropic` drops the tools for "none" unless
 * `patches/@ai-sdk__anthropic@3.0.125.patch` is applied; Bedrock reuses the same model
 * through its native Messages provider.
 */

const MESSAGE_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

function capturingFetch(bodies: Array<Record<string, unknown>>) {
  return (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(MESSAGE_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const tools = {
  list_runs: tool({
    description: "List the recent runs.",
    inputSchema: z.object({}),
    execute: async () => ({ runs: [] }),
  }),
};

async function wakeBody(model: LanguageModel, bodies: Array<Record<string, unknown>>) {
  await generateText({ model, prompt: "report", tools, toolChoice: "none" });
  return bodies.at(-1)!;
}

describe("a toolChoice none request", () => {
  it("keeps the tools declared on the Anthropic API", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const anthropic = createAnthropic({ apiKey: "test", fetch: capturingFetch(bodies) });
    const body = await wakeBody(anthropic("claude-sonnet-5-5"), bodies);

    expect(body.tool_choice).toEqual({ type: "none" });
    expect((body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["list_runs"]);
  });

  it("keeps the tools declared on Bedrock", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const bedrock = createBedrockAnthropic({
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      fetch: capturingFetch(bodies),
    });
    const body = await wakeBody(bedrock("us.anthropic.claude-sonnet-5-5"), bodies);

    expect(body.tool_choice).toEqual({ type: "none" });
    expect((body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["list_runs"]);
  });
});

describe("a conversation persisted before the native Bedrock switch", () => {
  // Converse stored a thinking block's signature under `bedrock`; the native provider
  // reads `anthropic`. Without the translation the block is dropped from the request.
  const persisted: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "why did it fail?" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "", providerMetadata: { bedrock: { signature: "sig_legacy" } } },
        { type: "text", text: "Looking at the runs." },
      ],
    },
    { id: "u2", role: "user", parts: [{ type: "text", text: "and now?" }] },
  ];

  it("replays its thinking block with the signature it was recorded with", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const bedrock = createBedrockAnthropic({
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      fetch: capturingFetch(bodies),
    });
    const messages = prepareTurnMessages({
      messages: await convertToModelMessages(persisted),
      reason: "run",
    });

    await generateText({
      model: bedrock("us.anthropic.claude-sonnet-5-5"),
      messages,
      providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
    });

    const assistant = (bodies.at(-1)!.messages as Array<{ role: string; content: unknown[] }>).find(
      (m) => m.role === "assistant"
    )!;
    expect(assistant.content[0]).toMatchObject({ type: "thinking", signature: "sig_legacy" });
  });
});
