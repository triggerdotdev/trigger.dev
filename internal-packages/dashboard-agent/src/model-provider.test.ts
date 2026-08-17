import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPT_CACHE_CONTROL } from "./prompt-prefix";
import {
  BEDROCK_MODEL_IDS,
  bedrockProviderSettings,
  bedrockRegion,
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

  it("throws rather than guessing a profile for an unmapped id", () => {
    useBedrock();
    expect(() => resolveDashboardAgentModel("anthropic:claude-made-up-9-9")).toThrow(
      /No Bedrock model mapping/
    );
  });

  // Structural, not an echo of the table: an AWS us cross-region Anthropic profile
  // is either dated with a `:N` suffix, or an undated `-vN` (the 4-6 generation). A
  // dated id must never drop its `:N`, and every id must end in a version.
  it("every Bedrock-mapped id has a well-formed AWS inference-profile shape", () => {
    const dated = /^us\.anthropic\.claude-[a-z]+(?:-\d+)+-\d{8}-v\d+:\d+$/;
    const undated = /^us\.anthropic\.claude-[a-z]+(?:-\d+)+-v\d+$/;
    for (const id of Object.values(BEDROCK_MODEL_IDS)) {
      expect(dated.test(id) || undated.test(id), id).toBe(true);
      if (/-\d{8}-/.test(id)) expect(id, id).toMatch(/:\d+$/);
    }
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
