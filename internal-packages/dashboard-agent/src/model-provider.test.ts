import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPT_CACHE_CONTROL } from "./prompt-prefix";
import {
  BEDROCK_MODEL_IDS,
  bedrockProviderSettings,
  bedrockRegion,
  dashboardAgentJudgeModel,
  dashboardAgentModel,
  dashboardAgentSummaryModel,
  dashboardAgentTitleModel,
  maxOutputTokensFor,
  promptModel,
  withoutThinking,
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

const AWS_ENV_VARS = [
  "DASHBOARD_AGENT_MODEL_PROVIDER",
  "DASHBOARD_AGENT_AWS_ACCESS_KEY_ID",
  "DASHBOARD_AGENT_AWS_SECRET_ACCESS_KEY",
  "DASHBOARD_AGENT_AWS_REGION",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

let priorEnv: Record<string, string | undefined>;

beforeEach(() => {
  priorEnv = Object.fromEntries(AWS_ENV_VARS.map((key) => [key, process.env[key]]));
  for (const key of AWS_ENV_VARS) delete process.env[key];
});

afterEach(() => {
  for (const key of AWS_ENV_VARS) {
    if (priorEnv[key] === undefined) delete process.env[key];
    else process.env[key] = priorEnv[key];
  }
});

describe("role models", () => {
  const ENV_KEYS = [
    "DASHBOARD_AGENT_MODEL",
    "DASHBOARD_AGENT_SUMMARY_MODEL",
    "DASHBOARD_AGENT_JUDGE_MODEL",
    "DASHBOARD_AGENT_TITLE_MODEL",
  ];
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("defaults the main roles to Sonnet 5 and titles to Haiku 4.5", () => {
    expect(dashboardAgentModel()).toBe("claude-sonnet-5");
    expect(dashboardAgentSummaryModel()).toBe("claude-sonnet-5");
    expect(dashboardAgentJudgeModel()).toBe("claude-sonnet-5");
    expect(dashboardAgentTitleModel()).toBe("claude-haiku-4-5");
  });

  it("follows the main model override for summaries and the judge unless they set their own", () => {
    process.env.DASHBOARD_AGENT_MODEL = "claude-opus-5";
    expect(dashboardAgentSummaryModel()).toBe("claude-opus-5");
    expect(dashboardAgentJudgeModel()).toBe("claude-opus-5");
    process.env.DASHBOARD_AGENT_SUMMARY_MODEL = "claude-haiku-4-5";
    expect(dashboardAgentSummaryModel()).toBe("claude-haiku-4-5");
    expect(dashboardAgentTitleModel()).toBe("claude-haiku-4-5");
  });

  it("accepts the canonical anthropic: prefix and ignores blanks", () => {
    process.env.DASHBOARD_AGENT_TITLE_MODEL = "anthropic:claude-sonnet-5";
    expect(dashboardAgentTitleModel()).toBe("claude-sonnet-5");
    process.env.DASHBOARD_AGENT_MODEL = "   ";
    expect(dashboardAgentModel()).toBe("claude-sonnet-5");
  });
});

describe("promptModel", () => {
  afterEach(() => {
    delete process.env.DASHBOARD_AGENT_TITLE_MODEL;
  });
  const role = { env: "DASHBOARD_AGENT_TITLE_MODEL", fallback: () => "claude-haiku-4-5" };

  it("uses the model the prompt version carries when nothing overrides it", () => {
    expect(promptModel({ model: "anthropic:claude-haiku-4-5", labels: ["current"] }, role)).toBe(
      "anthropic:claude-haiku-4-5"
    );
  });

  it("lets the role's env var beat the deployed prompt version", () => {
    process.env.DASHBOARD_AGENT_TITLE_MODEL = "claude-sonnet-5";
    expect(promptModel({ model: "anthropic:claude-haiku-4-5", labels: ["current"] }, role)).toBe(
      "anthropic:claude-sonnet-5"
    );
  });

  it("lets a dashboard override beat the env var", () => {
    process.env.DASHBOARD_AGENT_TITLE_MODEL = "claude-sonnet-5";
    expect(
      promptModel({ model: "anthropic:claude-opus-5", labels: ["current", "override"] }, role)
    ).toBe("anthropic:claude-opus-5");
  });

  it("falls back to the code default when the prompt carries no model", () => {
    expect(promptModel({ model: undefined, labels: [] }, role)).toBe("anthropic:claude-haiku-4-5");
  });
});

describe("withoutThinking", () => {
  it("sends the raw disabled thinking field on Bedrock", () => {
    useBedrock();
    expect(withoutThinking()).toEqual({
      bedrock: { additionalModelRequestFields: { thinking: { type: "disabled" } } },
    });
  });

  it("falls back to low effort on the direct Anthropic provider", () => {
    expect(withoutThinking()).toEqual({ anthropic: { effort: "low" } });
  });
});

describe("maxOutputTokensFor", () => {
  it("returns the documented ceiling for the models the agent runs, by canonical or bare id", () => {
    expect(maxOutputTokensFor("anthropic:claude-sonnet-5")).toBe(128_000);
    expect(maxOutputTokensFor("claude-sonnet-5")).toBe(128_000);
    expect(maxOutputTokensFor("anthropic:claude-haiku-4-5")).toBe(64_000);
  });

  it("leaves an unknown model to the provider's default", () => {
    expect(maxOutputTokensFor("anthropic:claude-made-up-9-9")).toBeUndefined();
  });
});

describe("resolveDashboardAgentModel", () => {
  it("resolves a canonical prompt string against Anthropic by default", () => {
    expect(resolveDashboardAgentModel("anthropic:claude-sonnet-4-6").modelId).toBe(
      "claude-sonnet-4-6"
    );
  });

  it("maps the same canonical string to a Bedrock inference profile", () => {
    useBedrock();
    expect(resolveDashboardAgentModel("anthropic:claude-sonnet-5").modelId).toBe(
      "us.anthropic.claude-sonnet-5"
    );
    expect(resolveDashboardAgentModel("anthropic:claude-sonnet-4-6").modelId).toBe(
      "us.anthropic.claude-sonnet-4-6"
    );
    expect(resolveDashboardAgentModel("anthropic:claude-haiku-4-5").modelId).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    );
  });

  it("throws rather than guessing a profile for an unmapped id", () => {
    useBedrock();
    expect(() => resolveDashboardAgentModel("anthropic:claude-made-up-9-9")).toThrow(
      /No Bedrock model mapping/
    );
  });

  // Pinned to Anthropic's official Bedrock model table, not a shape regex — there is
  // no shared suffix convention across models, so a well-formed id can still be wrong.
  it("maps every model to its exact documented Bedrock id", () => {
    expect(BEDROCK_MODEL_IDS).toEqual({
      "claude-sonnet-5": "us.anthropic.claude-sonnet-5",
      "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6",
      "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
  });
});

describe("cache breakpoints", () => {
  it("keeps the Anthropic cacheControl ttls intact, tagged with the discriminator", () => {
    expect(withCacheBreakpoint({ openai: { store: false } }, "prefix")).toEqual({
      __cacheBreakpoint: { kind: "prefix" },
      openai: { store: false },
      anthropic: { cacheControl: PROMPT_CACHE_CONTROL },
    });
    expect(withCacheBreakpoint(undefined, "step")).toEqual({
      __cacheBreakpoint: { kind: "step" },
      anthropic: { cacheControl: STEP_CACHE_CONTROL },
    });
  });

  it("emits a plain Bedrock cachePoint with no ttl for either marker", () => {
    useBedrock();
    for (const breakpoint of ["prefix", "step"] as const) {
      const options = withCacheBreakpoint(undefined, breakpoint);
      // The only thing the SDK serialises to AWS is bedrock.cachePoint — it must be plain.
      expect(options.bedrock.cachePoint).toEqual({ type: "default" });
      expect(options.bedrock.cachePoint).not.toHaveProperty("ttl");
      expect(options.__cacheBreakpoint).toEqual({ kind: breakpoint });
    }
  });

  it("classifies and strips the active provider's breakpoint via the discriminator", () => {
    const anthropicStep = withCacheBreakpoint({ anthropic: { keep: true } }, "step");
    expect(isStepCacheBreakpoint(anthropicStep)).toBe(true);
    expect(isLongLivedCacheBreakpoint(withCacheBreakpoint(undefined, "prefix"))).toBe(true);
    // The strip removes both the provider field and the top-level discriminator.
    expect(withoutCacheBreakpoint(anthropicStep)).toEqual({ anthropic: { keep: true } });

    useBedrock();
    const bedrockStep = withCacheBreakpoint(undefined, "step");
    const bedrockPrefix = withCacheBreakpoint(undefined, "prefix");
    // The two Bedrock markers are byte-identical on the wire — only the tag tells them apart.
    expect(bedrockStep.bedrock).toEqual(bedrockPrefix.bedrock);
    expect(isStepCacheBreakpoint(bedrockStep)).toBe(true);
    expect(isLongLivedCacheBreakpoint(bedrockStep)).toBe(false);
    expect(isLongLivedCacheBreakpoint(bedrockPrefix)).toBe(true);
    expect(withoutCacheBreakpoint(bedrockStep)).toEqual({});
  });

  // Conversations persisted before the __cacheBreakpoint discriminator existed carry
  // a bare anthropic.cacheControl. Detection must fall back to classifying its ttl.
  it("classifies a legacy Anthropic cacheControl with no discriminator by its ttl", () => {
    const legacyPrefix = { anthropic: { cacheControl: PROMPT_CACHE_CONTROL } };
    const legacyStepWithTtl = { anthropic: { cacheControl: STEP_CACHE_CONTROL } };
    const legacyStepNoTtl = { anthropic: { cacheControl: { type: "ephemeral" } } };

    expect(isLongLivedCacheBreakpoint(legacyPrefix)).toBe(true);
    expect(isStepCacheBreakpoint(legacyPrefix)).toBe(false);
    expect(isStepCacheBreakpoint(legacyStepWithTtl)).toBe(true);
    expect(isLongLivedCacheBreakpoint(legacyStepWithTtl)).toBe(false);
    expect(isStepCacheBreakpoint(legacyStepNoTtl)).toBe(true);
  });

  it("strips a legacy Anthropic cacheControl even while Bedrock is active", () => {
    useBedrock();
    const legacyStep = { anthropic: { cacheControl: STEP_CACHE_CONTROL, keep: true } };

    expect(withoutCacheBreakpoint(legacyStep)).toEqual({ anthropic: { keep: true } });
  });
});

describe("Bedrock region and credential resolution", () => {
  it("prefers DASHBOARD_AGENT_AWS_REGION over the global AWS region vars", () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_DEFAULT_REGION = "us-west-2";
    process.env.DASHBOARD_AGENT_AWS_REGION = "eu-west-1";
    expect(bedrockRegion()).toBe("eu-west-1");
  });

  it("falls back to AWS_REGION, then AWS_DEFAULT_REGION", () => {
    process.env.AWS_DEFAULT_REGION = "us-west-2";
    expect(bedrockRegion()).toBe("us-west-2");

    process.env.AWS_REGION = "us-east-1";
    expect(bedrockRegion()).toBe("us-east-1");
  });

  it("treats an empty region as unset at every tier", () => {
    process.env.DASHBOARD_AGENT_AWS_REGION = "";
    process.env.AWS_REGION = "";
    process.env.AWS_DEFAULT_REGION = "";
    expect(bedrockRegion()).toBeUndefined();
  });

  it("passes explicit credentials when the dedicated pair is set", () => {
    process.env.DASHBOARD_AGENT_AWS_ACCESS_KEY_ID = "AKIA_DASHBOARD_AGENT";
    process.env.DASHBOARD_AGENT_AWS_SECRET_ACCESS_KEY = "secret";
    process.env.DASHBOARD_AGENT_AWS_REGION = "eu-west-1";

    expect(bedrockProviderSettings()).toEqual({
      region: "eu-west-1",
      accessKeyId: "AKIA_DASHBOARD_AGENT",
      secretAccessKey: "secret",
    });
  });

  it("keeps the default credential chain when the dedicated pair is unset", () => {
    process.env.AWS_REGION = "us-east-1";
    expect(bedrockProviderSettings()).toEqual({ region: "us-east-1" });
  });

  it("keeps the default chain when only one half of the dedicated pair is set", () => {
    process.env.DASHBOARD_AGENT_AWS_ACCESS_KEY_ID = "AKIA_DASHBOARD_AGENT";
    expect(bedrockProviderSettings()).toEqual({ region: undefined });
  });
});
