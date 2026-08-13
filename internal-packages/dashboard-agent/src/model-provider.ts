import { bedrock } from "@ai-sdk/amazon-bedrock";
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

export const registry = createProviderRegistry({ anthropic, bedrock });

/** Canonical model id -> Bedrock inference profile. */
const BEDROCK_MODEL_IDS: Record<string, string> = {
  "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6-v1",
  "claude-haiku-4-5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
};

/** Resolve a canonical `"anthropic:<model-id>"` string against the active provider. */
export function resolveDashboardAgentModel(model: string) {
  const id = model.startsWith("anthropic:") ? model.slice("anthropic:".length) : model;
  if (dashboardAgentProvider() === "anthropic") {
    return registry.languageModel(`anthropic:${id}` as `anthropic:${string}`);
  }
  const bedrockId = BEDROCK_MODEL_IDS[id] ?? `us.anthropic.${id}`;
  return registry.languageModel(`bedrock:${bedrockId}` as `bedrock:${string}`);
}

/**
 * The two breakpoints a turn sets: the prefix one that spans the turn, and the
 * rolling per-step one.
 */
export type CacheBreakpoint = "prefix" | "step";

export const STEP_CACHE_CONTROL = { type: "ephemeral", ttl: "5m" } as const;

type ProviderOptions = Record<string, any> | undefined;

function cacheOptions(breakpoint: CacheBreakpoint): Record<string, any> {
  if (dashboardAgentProvider() === "anthropic") {
    return {
      anthropic: {
        cacheControl: breakpoint === "prefix" ? PROMPT_CACHE_CONTROL : STEP_CACHE_CONTROL,
      },
    };
  }
  // No ttl: Bedrock's 1h cache is not supported on every model we run, and its
  // default 5m applies to both breakpoints.
  return { bedrock: { cachePoint: { type: "default" } } };
}

/** Merge the active provider's breakpoint into a message's provider options. */
export function withCacheBreakpoint(
  providerOptions: ProviderOptions,
  breakpoint: CacheBreakpoint
): Record<string, any> {
  const [key, options] = Object.entries(cacheOptions(breakpoint))[0]!;
  return { ...providerOptions, [key]: { ...providerOptions?.[key], ...options } };
}

/**
 * Whether these options carry the rolling step breakpoint. On Bedrock a cache
 * point carries no ttl, so any breakpoint on a message counts as the rolling one.
 */
export function isStepCacheBreakpoint(providerOptions: ProviderOptions): boolean {
  if (dashboardAgentProvider() === "anthropic") {
    return providerOptions?.anthropic?.cacheControl?.ttl === STEP_CACHE_CONTROL.ttl;
  }
  return providerOptions?.bedrock?.cachePoint !== undefined;
}

/** Whether these options carry a breakpoint that outlives a step. */
export function isLongLivedCacheBreakpoint(providerOptions: ProviderOptions): boolean {
  if (dashboardAgentProvider() !== "anthropic") return false;
  const ttl = providerOptions?.anthropic?.cacheControl?.ttl;
  return typeof ttl === "string" && ttl !== STEP_CACHE_CONTROL.ttl;
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

/** The same options with the active provider's breakpoint removed. */
export function withoutCacheBreakpoint(providerOptions: ProviderOptions): Record<string, any> {
  const key = dashboardAgentProvider() === "anthropic" ? "anthropic" : "bedrock";
  const field = key === "anthropic" ? "cacheControl" : "cachePoint";
  const { [key]: provider, ...rest } = (providerOptions ?? {}) as Record<string, any>;
  const { [field]: _dropped, ...providerRest } = (provider ?? {}) as Record<string, any>;
  // An empty provider entry is not the same as no options for it, so drop the key.
  return Object.keys(providerRest).length > 0 ? { ...rest, [key]: providerRest } : rest;
}
