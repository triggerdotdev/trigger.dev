// `@trigger.dev/sdk/ai/test` MUST be imported before the agent module so the
// resource catalog is installed before `chat.agent({ id })` / `prompts.define`
// register at module load.
import "@trigger.dev/sdk/ai/test";

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { withCacheBreakpointOnLast } from "./agent-runtime";
import { prepareTurnMessages } from "./dashboard-agent";
import { PROMPT_CACHE_CONTROL } from "./prompt-prefix";

/**
 * Rolling the turn's cache breakpoint onto the last message must not take the rest of
 * that message's Anthropic options with it: writing the namespace wholesale silently
 * dropped every other option the message carried.
 */

function lastMessageWithAnthropicOptions(): ModelMessage[] {
  return [
    { role: "user", content: "first" },
    {
      role: "user",
      content: "second",
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" }, thinking: { budget: 1024 } },
        openai: { store: false },
      },
    },
  ];
}

describe("withCacheBreakpointOnLast", () => {
  it("keeps the last message's other Anthropic options alongside the breakpoint", () => {
    const prepared = withCacheBreakpointOnLast(lastMessageWithAnthropicOptions());

    expect(prepared[1]!.providerOptions).toEqual({
      __cacheBreakpoint: { kind: "prefix" },
      anthropic: { cacheControl: PROMPT_CACHE_CONTROL, thinking: { budget: 1024 } },
      openai: { store: false },
    });
  });

  it("leaves earlier messages untouched", () => {
    const messages = lastMessageWithAnthropicOptions();
    expect(withCacheBreakpointOnLast(messages)[0]).toEqual(messages[0]);
  });
});

describe("prepareTurnMessages", () => {
  it("keeps the last message's other Anthropic options alongside the breakpoint", () => {
    const prepared = prepareTurnMessages({
      messages: lastMessageWithAnthropicOptions(),
      reason: "run",
    });

    expect(prepared[1]!.providerOptions).toEqual({
      __cacheBreakpoint: { kind: "prefix" },
      anthropic: { cacheControl: PROMPT_CACHE_CONTROL, thinking: { budget: 1024 } },
      openai: { store: false },
    });
  });

  it("still coerces a replayed tool input the API would reject", () => {
    const prepared = prepareTurnMessages({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "noop", input: "" }],
        },
      ],
      reason: "run",
    });

    expect((prepared[0]!.content as { input: unknown }[])[0]!.input).toEqual({});
  });
});
