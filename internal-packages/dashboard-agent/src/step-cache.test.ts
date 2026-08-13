import { afterEach, describe, expect, it } from "vitest";
import {
  markStepCacheBreakpoint,
  MIN_STEP_CACHE_CHARS,
  stepCacheAttributes,
  STEP_CACHE_CONTROL,
  withStepCacheBreakpoint,
} from "./step-cache";
import { PROMPT_CACHE_CONTROL } from "./prompt-prefix";
import { withCacheBreakpoint } from "./model-provider";

type Message = {
  role: string;
  content: unknown;
  providerOptions?: Record<string, unknown>;
};

function toolResult(chars: number): Message {
  return { role: "tool", content: [{ type: "tool-result", output: "x".repeat(chars) }] };
}

function turnHistory(): Message {
  return {
    role: "user",
    content: "why did run_1 fail?",
    providerOptions: { anthropic: { cacheControl: PROMPT_CACHE_CONTROL } },
  };
}

function stepBreakpointWith(otherAnthropicOptions: Record<string, unknown>): Message {
  return {
    role: "tool",
    content: "ok",
    providerOptions: {
      anthropic: { cacheControl: STEP_CACHE_CONTROL, ...otherAnthropicOptions },
      openai: { store: false },
    },
  };
}

function ttlOf(message: Message | undefined): unknown {
  return (message?.providerOptions?.anthropic as { cacheControl?: { ttl?: unknown } } | undefined)
    ?.cacheControl?.ttl;
}

describe("the step cache breakpoint", () => {
  it("uses a 5 minute ttl, not the prefix's hour", () => {
    expect(STEP_CACHE_CONTROL).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(PROMPT_CACHE_CONTROL.ttl).toBe("1h");
  });

  it("marks the last message once the step has accumulated enough to cache", () => {
    const messages = [turnHistory(), toolResult(MIN_STEP_CACHE_CHARS)];
    const marked = markStepCacheBreakpoint(messages);

    expect(ttlOf(marked.at(-1))).toBe("5m");
    expect(ttlOf(marked[0])).toBe("1h");
  });

  it("marks nothing while the accumulated tail is below the cacheable minimum", () => {
    const messages = [turnHistory(), toolResult(20)];
    const marked = markStepCacheBreakpoint(messages);

    expect(ttlOf(marked.at(-1))).toBeUndefined();
    expect(ttlOf(marked[0])).toBe("1h");
  });

  it("keeps at most one step breakpoint as the steps go by", () => {
    const first = markStepCacheBreakpoint([turnHistory(), toolResult(MIN_STEP_CACHE_CHARS)]);
    const second = markStepCacheBreakpoint([...first, toolResult(MIN_STEP_CACHE_CHARS)]);

    const stepBreakpoints = second.filter((message) => ttlOf(message) === "5m");
    expect(stepBreakpoints).toHaveLength(1);
    expect(ttlOf(second.at(-1))).toBe("5m");
    expect(second.filter((message) => ttlOf(message) !== undefined)).toHaveLength(2);
  });

  it("drops a stale step breakpoint when the tail is no longer worth one", () => {
    const marked = markStepCacheBreakpoint([turnHistory(), toolResult(MIN_STEP_CACHE_CHARS)]);
    const compacted = markStepCacheBreakpoint([
      turnHistory(),
      { ...marked.at(-1)!, content: "ok" },
    ]);

    expect(compacted.filter((message) => ttlOf(message) === "5m")).toHaveLength(0);
  });

  it("keeps the other anthropic options when it rolls the breakpoint off", () => {
    const marked = markStepCacheBreakpoint([
      stepBreakpointWith({ anotherOption: "keep" }),
      toolResult(MIN_STEP_CACHE_CHARS),
    ]);

    expect(marked[0]!.providerOptions).toEqual({
      anthropic: { anotherOption: "keep" },
      openai: { store: false },
    });
    expect(ttlOf(marked.at(-1))).toBe("5m");
  });

  it("keeps the marked message's other anthropic options when it sets the breakpoint", () => {
    const marked = markStepCacheBreakpoint([
      turnHistory(),
      {
        ...toolResult(MIN_STEP_CACHE_CHARS),
        providerOptions: { anthropic: { anotherOption: "keep" }, openai: { store: false } },
      },
    ]);

    expect(marked.at(-1)!.providerOptions).toEqual({
      anthropic: { anotherOption: "keep", cacheControl: STEP_CACHE_CONTROL },
      openai: { store: false },
    });
  });

  it("leaves no empty anthropic object behind", () => {
    const marked = markStepCacheBreakpoint([
      stepBreakpointWith({}),
      toolResult(MIN_STEP_CACHE_CHARS),
    ]);

    expect(marked[0]!.providerOptions).toEqual({ openai: { store: false } });
  });

  it("does nothing to an empty step", () => {
    const empty: Message[] = [];
    expect(markStepCacheBreakpoint(empty)).toBe(empty);
  });
});

describe("the step cache breakpoint on Bedrock", () => {
  afterEach(() => {
    delete process.env.DASHBOARD_AGENT_MODEL_PROVIDER;
  });

  function bedrockCachePoint(message: Message | undefined): { ttl?: unknown } | undefined {
    return (message?.providerOptions?.bedrock as { cachePoint?: { ttl?: unknown } } | undefined)
      ?.cachePoint;
  }

  // The turn-wide prefix marker sits on the last message; a short conversation never
  // earns a step marker, so stripping the prefix would leave the history uncached.
  it("keeps the turn-wide prefix cachePoint on a short conversation", () => {
    process.env.DASHBOARD_AGENT_MODEL_PROVIDER = "bedrock";
    const last: Message = {
      role: "user",
      content: "why did run_1 fail?",
      providerOptions: withCacheBreakpoint(undefined, "prefix"),
    };
    const marked = markStepCacheBreakpoint([last]);

    const cachePoint = bedrockCachePoint(marked.at(-1));
    expect(cachePoint).toEqual({ type: "default" });
    expect(cachePoint?.ttl).toBeUndefined();
  });

  it("rolls the per-step cachePoint onto the tail once it is worth caching", () => {
    process.env.DASHBOARD_AGENT_MODEL_PROVIDER = "bedrock";
    const prefix: Message = {
      role: "user",
      content: "why did run_1 fail?",
      providerOptions: withCacheBreakpoint(undefined, "prefix"),
    };
    const marked = markStepCacheBreakpoint([prefix, toolResult(MIN_STEP_CACHE_CHARS)]);

    expect(bedrockCachePoint(marked[0])).toEqual({ type: "default" });
    expect(bedrockCachePoint(marked.at(-1))).toEqual({ type: "default", ttl: "5m" });
  });
});

describe("wrapping the SDK's prepareStep", () => {
  it("marks whatever the inner prepareStep returned", async () => {
    const compactedTo = [turnHistory(), toolResult(MIN_STEP_CACHE_CHARS)];
    const inner = () => ({ messages: compactedTo });

    const prepared = await withStepCacheBreakpoint(inner as never)({
      messages: [turnHistory()],
    } as never);

    expect(prepared!.messages).toHaveLength(2);
    expect(ttlOf(prepared!.messages!.at(-1) as Message)).toBe("5m");
  });

  it("falls back to the step's own messages when there is no inner prepareStep", async () => {
    const prepared = await withStepCacheBreakpoint(undefined)({
      messages: [turnHistory(), toolResult(MIN_STEP_CACHE_CHARS)],
    } as never);

    expect(ttlOf(prepared!.messages!.at(-1) as Message)).toBe("5m");
  });

  it("keeps the last message's other anthropic options", async () => {
    const inner = () => ({
      messages: [
        turnHistory(),
        {
          ...toolResult(MIN_STEP_CACHE_CHARS),
          providerOptions: { anthropic: { anotherOption: "keep" } },
        },
      ],
    });

    const prepared = await withStepCacheBreakpoint(inner as never)({ messages: [] } as never);

    expect((prepared!.messages!.at(-1) as Message).providerOptions).toEqual({
      anthropic: { anotherOption: "keep", cacheControl: STEP_CACHE_CONTROL },
    });
  });

  it("keeps the rest of the inner result", async () => {
    const inner = () => ({ toolChoice: "none", messages: [turnHistory()] });
    const prepared = (await withStepCacheBreakpoint(inner as never)({
      messages: [],
    } as never)) as Record<string, unknown>;

    expect(prepared.toolChoice).toBe("none");
  });
});

describe("per-step cache telemetry", () => {
  it("reports the provider's write and read counts", () => {
    expect(
      stepCacheAttributes(2, {
        anthropic: { cacheCreationInputTokens: 8_000, cacheReadInputTokens: 12_000 },
      })
    ).toEqual({
      "dashboard_agent.step": 2,
      "gen_ai.usage.cache_creation_input_tokens": 8_000,
      "gen_ai.usage.cache_read_input_tokens": 12_000,
    });
  });

  it("reports Bedrock's write from its metadata and its read from the call's usage", () => {
    process.env.DASHBOARD_AGENT_MODEL_PROVIDER = "bedrock";
    try {
      expect(
        stepCacheAttributes(
          2,
          { bedrock: { usage: { cacheWriteInputTokens: 8_000 } } },
          { inputTokenDetails: { cacheReadTokens: 12_000 } }
        )
      ).toEqual({
        "dashboard_agent.step": 2,
        "gen_ai.usage.cache_creation_input_tokens": 8_000,
        "gen_ai.usage.cache_read_input_tokens": 12_000,
      });
    } finally {
      delete process.env.DASHBOARD_AGENT_MODEL_PROVIDER;
    }
  });

  it("reports null rather than zero when the provider said nothing", () => {
    expect(stepCacheAttributes(0, undefined)).toEqual({
      "dashboard_agent.step": 0,
      "gen_ai.usage.cache_creation_input_tokens": null,
      "gen_ai.usage.cache_read_input_tokens": null,
    });
  });
});
