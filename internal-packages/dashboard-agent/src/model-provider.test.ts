import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_CACHE_CONTROL } from "./prompt-prefix";
import {
  isLongLivedCacheBreakpoint,
  isStepCacheBreakpoint,
  resolveDashboardAgentModel,
  STEP_CACHE_CONTROL,
  withCacheBreakpoint,
  withoutCacheBreakpoint,
} from "./model-provider";

function useBedrock() {
  process.env.DASHBOARD_AGENT_MODEL_PROVIDER = "bedrock";
}

afterEach(() => {
  delete process.env.DASHBOARD_AGENT_MODEL_PROVIDER;
});

describe("resolveDashboardAgentModel", () => {
  it("resolves a canonical prompt string against Anthropic by default", () => {
    expect(resolveDashboardAgentModel("anthropic:claude-sonnet-4-6").modelId).toBe(
      "claude-sonnet-4-6"
    );
  });

  it("maps the same canonical string to a Bedrock inference profile", () => {
    useBedrock();
    expect(resolveDashboardAgentModel("anthropic:claude-sonnet-4-6").modelId).toBe(
      "us.anthropic.claude-sonnet-4-6-v1"
    );
    expect(resolveDashboardAgentModel("anthropic:claude-haiku-4-5").modelId).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    );
  });
});

describe("cache breakpoints", () => {
  it("emits Anthropic cache control by default", () => {
    expect(withCacheBreakpoint({ openai: { store: false } }, "prefix")).toEqual({
      openai: { store: false },
      anthropic: { cacheControl: PROMPT_CACHE_CONTROL },
    });
    expect(withCacheBreakpoint(undefined, "step")).toEqual({
      anthropic: { cacheControl: STEP_CACHE_CONTROL },
    });
  });

  it("emits a Bedrock cache point when the switch is on", () => {
    useBedrock();
    expect(withCacheBreakpoint(undefined, "prefix")).toEqual({
      bedrock: { cachePoint: { type: "default" } },
    });
  });

  it("classifies and strips the active provider's breakpoint", () => {
    const anthropicStep = withCacheBreakpoint({ anthropic: { keep: true } }, "step");
    expect(isStepCacheBreakpoint(anthropicStep)).toBe(true);
    expect(isLongLivedCacheBreakpoint(withCacheBreakpoint(undefined, "prefix"))).toBe(true);
    expect(withoutCacheBreakpoint(anthropicStep)).toEqual({ anthropic: { keep: true } });

    useBedrock();
    const bedrockStep = withCacheBreakpoint(undefined, "step");
    expect(isStepCacheBreakpoint(bedrockStep)).toBe(true);
    expect(isLongLivedCacheBreakpoint(bedrockStep)).toBe(false);
    expect(withoutCacheBreakpoint(bedrockStep)).toEqual({});
  });
});
