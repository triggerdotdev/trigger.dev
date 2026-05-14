import {
  AI_CONTENT_DROP_PRIORITY,
  AI_CONTENT_KEY_OVERRIDES,
  capAssembledAttributesSize,
  truncateAttributes,
} from "~/v3/otlpAttributeLimits";

describe("truncateAttributes", () => {
  it("truncates string values to the default cap", () => {
    const out = truncateAttributes({ "user.message": "x".repeat(10_000) }, 100);
    expect(typeof out?.["user.message"]).toBe("string");
    expect((out?.["user.message"] as string).length).toBeLessThanOrEqual(100);
  });

  it("leaves non-string values untouched", () => {
    const out = truncateAttributes(
      {
        "user.count": 42,
        "user.flag": true,
        "user.missing": undefined,
      },
      100
    );
    expect(out?.["user.count"]).toBe(42);
    expect(out?.["user.flag"]).toBe(true);
    expect(out?.["user.missing"]).toBeUndefined();
  });

  it("applies a per-key override to matching prefix and dotted children", () => {
    const overrides = [{ prefix: "ai.prompt", limit: 32 }];
    const out = truncateAttributes(
      {
        "ai.prompt": "p".repeat(1000),
        "ai.prompt.messages": "m".repeat(1000),
        "ai.prompt.tools": "t".repeat(1000),
        "ai.model.id": "claude-sonnet-4-20250514",
      },
      4096,
      overrides
    );
    expect((out?.["ai.prompt"] as string).length).toBeLessThanOrEqual(32);
    expect((out?.["ai.prompt.messages"] as string).length).toBeLessThanOrEqual(32);
    expect((out?.["ai.prompt.tools"] as string).length).toBeLessThanOrEqual(32);
    // Non-matching key keeps the default cap (well below it).
    expect(out?.["ai.model.id"]).toBe("claude-sonnet-4-20250514");
  });

  it("first-matching override wins", () => {
    const overrides = [
      { prefix: "ai.prompt", limit: 8 },
      { prefix: "ai.prompt.messages", limit: 1024 }, // shadowed
    ];
    const out = truncateAttributes(
      { "ai.prompt.messages": "x".repeat(500) },
      4096,
      overrides
    );
    expect((out?.["ai.prompt.messages"] as string).length).toBeLessThanOrEqual(8);
  });

  it("does not match a key that only shares a prefix substring (no dot boundary)", () => {
    const overrides = [{ prefix: "ai.prompt", limit: 8 }];
    const out = truncateAttributes(
      // "ai.prompts" should NOT match "ai.prompt"; the override requires
      // exact match or a dot boundary.
      { "ai.prompts": "x".repeat(500) },
      4096,
      overrides
    );
    expect((out?.["ai.prompts"] as string).length).toBe(500);
  });

  it("returns undefined when input is undefined", () => {
    expect(truncateAttributes(undefined, 100)).toBeUndefined();
  });
});

describe("AI_CONTENT_KEY_OVERRIDES", () => {
  it("targets prompt content keys but not cost / model metadata", () => {
    const overrides = AI_CONTENT_KEY_OVERRIDES(1024);
    const prefixes = overrides.map((o) => o.prefix);

    // Content keys we want capped.
    expect(prefixes).toContain("ai.prompt");
    expect(prefixes).toContain("ai.response.text");
    expect(prefixes).toContain("ai.response.object");
    expect(prefixes).toContain("ai.response.toolCalls");
    expect(prefixes).toContain("gen_ai.prompt");
    expect(prefixes).toContain("gen_ai.completion");
    expect(prefixes).toContain("gen_ai.request.messages");

    // Cost/model metadata MUST NOT be in the override list — those keys
    // feed enrichCreatableEvents and the dashboard's LLM pills.
    expect(prefixes).not.toContain("ai.usage");
    expect(prefixes).not.toContain("ai.model");
    expect(prefixes).not.toContain("ai.operationId");
    expect(prefixes).not.toContain("ai.settings");
    expect(prefixes).not.toContain("ai.telemetry");
    expect(prefixes).not.toContain("gen_ai.usage");
    expect(prefixes).not.toContain("gen_ai.response.model");
    expect(prefixes).not.toContain("gen_ai.request.model");
    expect(prefixes).not.toContain("gen_ai.system");
    expect(prefixes).not.toContain("gen_ai.operation.name");

    // Every override carries the limit we passed in.
    for (const o of overrides) {
      expect(o.limit).toBe(1024);
    }
  });
});

describe("capAssembledAttributesSize", () => {
  it("is a no-op when input is already under budget", () => {
    const input = {
      "ai.prompt.messages": "small",
      "ai.usage.input_tokens": 10,
    };
    const out = capAssembledAttributesSize(input, 4096);
    expect(out).toEqual(input);
  });

  it("returns an empty object when input is undefined", () => {
    expect(capAssembledAttributesSize(undefined, 4096)).toEqual({});
  });

  it("drops AI content keys in priority order until under budget", () => {
    // Build a payload where the AI content alone overflows 2KB but cost
    // metadata fits comfortably. After dropping `ai.prompt.messages` the
    // remaining payload is well under budget, so subsequent priority
    // entries should NOT be dropped.
    const input = {
      "ai.prompt.messages": "x".repeat(4000),
      "ai.response.text": "y",
      "ai.response.object": "z",
      "ai.usage.input_tokens": 100,
      "ai.usage.output_tokens": 50,
      "gen_ai.response.model": "claude-sonnet-4-20250514",
      "ai.model.id": "claude-sonnet-4-20250514",
    } as Record<string, string | number | boolean | undefined>;

    const out = capAssembledAttributesSize(input, 2048);

    expect(out["ai.prompt.messages"]).toBeUndefined();
    // Cost / model metadata is preserved.
    expect(out["ai.usage.input_tokens"]).toBe(100);
    expect(out["ai.usage.output_tokens"]).toBe(50);
    expect(out["gen_ai.response.model"]).toBe("claude-sonnet-4-20250514");
    expect(out["ai.model.id"]).toBe("claude-sonnet-4-20250514");
    // Lower-priority content keys that weren't needed to fit the budget
    // are preserved.
    expect(out["ai.response.text"]).toBe("y");
    expect(out["ai.response.object"]).toBe("z");
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2048);
  });

  it("drops keys with dotted children matching a priority prefix", () => {
    const input = {
      "ai.prompt": "p".repeat(1000),
      "ai.prompt.messages": "m".repeat(1000),
      "ai.prompt.tools": "t".repeat(1000),
      "ai.usage.input_tokens": 5,
    } as Record<string, string | number | boolean | undefined>;

    // Cap below the ai.prompt.* payload total so the whole prompt namespace
    // gets dropped.
    const out = capAssembledAttributesSize(input, 256);

    expect(out["ai.prompt"]).toBeUndefined();
    expect(out["ai.prompt.messages"]).toBeUndefined();
    expect(out["ai.prompt.tools"]).toBeUndefined();
    expect(out["ai.usage.input_tokens"]).toBe(5);
  });

  it("AI_CONTENT_DROP_PRIORITY puts highest-volume content first", () => {
    // ai.prompt.messages is the heaviest in practice (full conversation
    // history). It should be the first thing to go.
    expect(AI_CONTENT_DROP_PRIORITY[0]).toBe("ai.prompt.messages");
  });

  it("preserves non-AI attributes regardless of priority list", () => {
    const input = {
      "user.event": "y".repeat(5000),
      "ai.prompt.messages": "x".repeat(5000),
    } as Record<string, string | number | boolean | undefined>;

    const out = capAssembledAttributesSize(input, 1024);

    expect(out["ai.prompt.messages"]).toBeUndefined();
    // User-defined non-AI attribute stays even though it's the only thing
    // pushing the budget. The drop list only covers AI content prefixes —
    // we don't silently shrink customer data.
    expect(typeof out["user.event"]).toBe("string");
  });
});
