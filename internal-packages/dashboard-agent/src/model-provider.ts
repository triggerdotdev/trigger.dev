import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { anthropic } from "@ai-sdk/anthropic";
import { createProviderRegistry } from "ai";
import { PROMPT_CACHE_CONTROL } from "./prompt-prefix";

/**
 * Which provider the agent's model calls go through, and the two things that
 * differ between them: the model id, and the shape of the prompt-cache options.
 *
 * Managed prompts stay canonical `"anthropic:<model-id>"` strings whichever
 * provider is active, so a stored or dashboard-overridden prompt keeps meaning
 * the same model.
 *
 * Kept free of the SDK runtime so the webapp's head-start path can import it.
 */

export type DashboardAgentProvider = "anthropic" | "bedrock";

/** Global switch, read per call so it can be set per environment. */
export function dashboardAgentProvider(): DashboardAgentProvider {
  return process.env.DASHBOARD_AGENT_MODEL_PROVIDER === "bedrock" ? "bedrock" : "anthropic";
}

// Region passed explicitly since the SDK reads only AWS_REGION; credentials stay on
// its own chain. `||` treats an empty region as unset, matching the webapp gate.
const bedrock = createAmazonBedrock({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

export const registry = createProviderRegistry({ anthropic, bedrock });

/**
 * Canonical model id -> Bedrock us cross-region inference profile, verbatim from
 * the @ai-sdk/amazon-bedrock model-id union. The 4-6 generation profiles are
 * undated `-vN`; 4-5 and older carry a date and a `:N` suffix.
 */
export const BEDROCK_MODEL_IDS: Record<string, string> = {
  "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6-v1",
  "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
};

/** Resolve a canonical `"anthropic:<model-id>"` string against the active provider. */
export function resolveDashboardAgentModel(model: string) {
  const id = model.startsWith("anthropic:") ? model.slice("anthropic:".length) : model;
  if (dashboardAgentProvider() === "anthropic") {
    return registry.languageModel(`anthropic:${id}` as `anthropic:${string}`);
  }
  const bedrockId = BEDROCK_MODEL_IDS[id];
  if (!bedrockId) {
    // No Bedrock profile can be guessed from the canonical id — a made-up one is a
    // guaranteed 404, so fail loudly instead.
    throw new Error(`No Bedrock model mapping for "${id}"`);
  }
  return registry.languageModel(`bedrock:${bedrockId}` as `bedrock:${string}`);
}

/**
 * The two breakpoints a turn sets: the prefix one that spans the turn, and the
 * rolling per-step one.
 */
export type CacheBreakpoint = "prefix" | "step";

export const STEP_CACHE_CONTROL = { type: "ephemeral", ttl: "5m" } as const;

type ProviderOptions = Record<string, any> | undefined;

// Breakpoint discriminator under a top-level key no provider serialises. Value is an
// object because the AI SDK validates providerOptions as records, rejecting a bare string.
const CACHE_BREAKPOINT_KEY = "__cacheBreakpoint";

function breakpointKind(providerOptions: ProviderOptions): CacheBreakpoint | undefined {
  const discriminated = providerOptions?.[CACHE_BREAKPOINT_KEY]?.kind;
  if (discriminated) return discriminated;
  // Conversations persisted before the discriminator existed carry a bare Anthropic
  // cacheControl. Classify it by ttl: "1h" is the turn-wide prefix, anything else the step.
  const legacyCacheControl = providerOptions?.anthropic?.cacheControl;
  if (!legacyCacheControl) return undefined;
  return legacyCacheControl.ttl === "1h" ? "prefix" : "step";
}

function cacheOptions(breakpoint: CacheBreakpoint): Record<string, any> {
  if (dashboardAgentProvider() === "anthropic") {
    return {
      anthropic: {
        cacheControl: breakpoint === "prefix" ? PROMPT_CACHE_CONTROL : STEP_CACHE_CONTROL,
      },
    };
  }
  // Plain, documented cachePoint for both markers — nothing undocumented reaches AWS.
  return { bedrock: { cachePoint: { type: "default" } } };
}

/** Merge the active provider's breakpoint into a message's provider options. */
export function withCacheBreakpoint(
  providerOptions: ProviderOptions,
  breakpoint: CacheBreakpoint
): Record<string, any> {
  const [key, options] = Object.entries(cacheOptions(breakpoint))[0]!;
  return {
    ...providerOptions,
    [CACHE_BREAKPOINT_KEY]: { kind: breakpoint },
    [key]: { ...providerOptions?.[key], ...options },
  };
}

/**
 * Whether these options carry the rolling step breakpoint — the one the step-strip
 * pass rolls off.
 */
export function isStepCacheBreakpoint(providerOptions: ProviderOptions): boolean {
  return breakpointKind(providerOptions) === "step";
}

/** Whether these options carry a breakpoint that outlives a step (the turn-wide prefix). */
export function isLongLivedCacheBreakpoint(providerOptions: ProviderOptions): boolean {
  return breakpointKind(providerOptions) === "prefix";
}

/**
 * The cache token counts the active provider reports on a call's metadata.
 * Bedrock puts only the write there; its read count reaches the call's usage.
 */
export function cacheUsageFromProviderMetadata(providerMetadata: unknown): {
  write?: number;
  read?: number;
} {
  const metadata = providerMetadata as Record<string, any> | undefined;
  const count = (value: unknown) => (typeof value === "number" ? value : undefined);
  if (dashboardAgentProvider() === "anthropic") {
    return {
      write: count(metadata?.anthropic?.cacheCreationInputTokens),
      read: count(metadata?.anthropic?.cacheReadInputTokens),
    };
  }
  return { write: count(metadata?.bedrock?.usage?.cacheWriteInputTokens) };
}

/** The same options with the active provider's breakpoint and its discriminator removed. */
export function withoutCacheBreakpoint(providerOptions: ProviderOptions): Record<string, any> {
  const hasDiscriminator = providerOptions?.[CACHE_BREAKPOINT_KEY] !== undefined;
  // A legacy message keeps its native anthropic.cacheControl shape no matter which
  // provider is active now, so strip that key rather than the current provider's.
  const isLegacy = !hasDiscriminator && providerOptions?.anthropic?.cacheControl !== undefined;
  const key = isLegacy
    ? "anthropic"
    : dashboardAgentProvider() === "anthropic"
      ? "anthropic"
      : "bedrock";
  const field = key === "anthropic" ? "cacheControl" : "cachePoint";
  const {
    [key]: provider,
    [CACHE_BREAKPOINT_KEY]: _tag,
    ...rest
  } = (providerOptions ?? {}) as Record<string, any>;
  const { [field]: _dropped, ...providerRest } = (provider ?? {}) as Record<string, any>;
  // An empty provider entry is not the same as no options for it, so drop the key.
  return Object.keys(providerRest).length > 0 ? { ...rest, [key]: providerRest } : rest;
}
