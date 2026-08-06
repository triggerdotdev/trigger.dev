import { describe, expect, it } from "vitest";
import {
  markStepCacheBreakpoint,
  MIN_STEP_CACHE_CHARS,
  stepCacheAttributes,
  STEP_CACHE_CONTROL,
  withStepCacheBreakpoint,
} from "./step-cache";
import { PROMPT_CACHE_CONTROL } from "./prompt-prefix";

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

  it("does nothing to an empty step", () => {
    const empty: Message[] = [];
    expect(markStepCacheBreakpoint(empty)).toBe(empty);
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

  it("reports null rather than zero when the provider said nothing", () => {
    expect(stepCacheAttributes(0, undefined)).toEqual({
      "dashboard_agent.step": 0,
      "gen_ai.usage.cache_creation_input_tokens": null,
      "gen_ai.usage.cache_read_input_tokens": null,
    });
  });
});
