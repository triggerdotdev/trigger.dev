import { createBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { anthropic } from "@ai-sdk/anthropic";
import { createProviderRegistry, type streamText } from "ai";
import { PROMPT_CACHE_CONTROL } from "./prompt-prefix";

/**
 * Which provider the agent's model calls go through. Both speak Anthropic's Messages
 * API: Bedrock through its `InvokeModel` endpoints, which take the native request
 * body, rather than Converse, which can't express every option the agent sends (no
 * `tool_choice: none`, no `between_tools` thinking). So the provider options are the
 * same `anthropic` shape on both, and only the model id differs.
 *
 * Managed prompts stay canonical `"anthropic:<model-id>"` strings whichever
 * provider is active, so a stored or dashboard-overridden prompt keeps meaning
 * the same model.
 *
 * Kept free of the SDK runtime so the webapp's head-start path can import it.
 */

export type DashboardAgentProvider = "anthropic" | "bedrock";

/**
 * The models each role runs on, as canonical ids (`claude-…`, no provider prefix).
 * Each has a code default and an env override, read per call so an environment can
 * change a role without a release: the agent project's env for the run, the webApp's
 * env for the head-start step. A prompt override in the dashboard still wins for the
 * main turns, since `run()` reads the resolved prompt's model first. On Bedrock the id
 * must be in `BEDROCK_MODEL_IDS`, or the resolve throws rather than guessing.
 */
export const DEFAULT_DASHBOARD_AGENT_MODEL = "claude-sonnet-5";
export const DEFAULT_DASHBOARD_AGENT_TITLE_MODEL = "claude-haiku-4-5";

function canonicalId(value: string): string {
  return value.startsWith("anthropic:") ? value.slice("anthropic:".length) : value;
}

/**
 * The env override for a role, or undefined when unset or blank. `value` lets a caller
 * that validates its env itself (the webapp) hand the read value in instead.
 */
function modelOverride(name: string, value = process.env[name]): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? canonicalId(trimmed) : undefined;
}

/** Main turns, the code and watch prompts, and the head-start step. */
export function dashboardAgentModel(envValue?: string): string {
  return modelOverride("DASHBOARD_AGENT_MODEL", envValue) ?? DEFAULT_DASHBOARD_AGENT_MODEL;
}

/** Compaction summaries. Defaults to the main model. */
export function dashboardAgentSummaryModel(): string {
  return modelOverride("DASHBOARD_AGENT_SUMMARY_MODEL") ?? dashboardAgentModel();
}

/** The turn eval judge. Defaults to the main model. */
export function dashboardAgentJudgeModel(): string {
  return modelOverride("DASHBOARD_AGENT_JUDGE_MODEL") ?? dashboardAgentModel();
}

/** Chat titles: a short call where the small model is enough. */
export function dashboardAgentTitleModel(): string {
  return modelOverride("DASHBOARD_AGENT_TITLE_MODEL") ?? DEFAULT_DASHBOARD_AGENT_TITLE_MODEL;
}

/**
 * The model a managed prompt's call runs on, as a canonical `"anthropic:<id>"` string.
 * A prompt version registers the model its code default evaluated to at deploy time, so
 * `resolved.model` alone would make the env overrides above inert. Precedence: a
 * dashboard override on the prompt wins (someone chose it deliberately for this
 * environment), then the role's env var, then the model the prompt version carries,
 * then the code default.
 */
export function promptModel(
  resolved: { model: string | undefined; labels?: string[] },
  role: { env: string; fallback: () => string }
): string {
  if (resolved.labels?.includes("override") && resolved.model) return resolved.model;
  const override = modelOverride(role.env);
  if (override) return `anthropic:${override}`;
  return resolved.model ?? `anthropic:${role.fallback()}`;
}

/** Global switch, read per call so it can be set per environment. */
export function dashboardAgentProvider(): DashboardAgentProvider {
  return process.env.DASHBOARD_AGENT_MODEL_PROVIDER === "bedrock" ? "bedrock" : "anthropic";
}

// Region passed explicitly since the SDK reads only AWS_REGION. `||` treats an empty
// region as unset. DASHBOARD_AGENT_AWS_REGION takes priority over the global vars.
export function bedrockRegion(): string | undefined {
  return (
    process.env.DASHBOARD_AGENT_AWS_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    undefined
  );
}

// Dedicated, non-global credentials only — the default chain (and the global
// AWS_ACCESS_KEY_ID/etc, if ever set) stays untouched for the ECR/STS deploy clients.
function bedrockCredentials(): { accessKeyId: string; secretAccessKey: string } | undefined {
  const accessKeyId = process.env.DASHBOARD_AGENT_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.DASHBOARD_AGENT_AWS_SECRET_ACCESS_KEY;
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
}

export function bedrockProviderSettings(): {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
} {
  return { region: bedrockRegion(), ...bedrockCredentials() };
}

const bedrock = createBedrockAnthropic(bedrockProviderSettings());

export const registry = createProviderRegistry({ anthropic, bedrock });

/**
 * Canonical model id -> Bedrock us cross-region inference profile, verbatim from
 * Anthropic's official Bedrock model table. No shared suffix convention across
 * models — copy each id exactly rather than deriving it.
 */
export const BEDROCK_MODEL_IDS: Record<string, string> = {
  "claude-sonnet-5-5": "us.anthropic.claude-sonnet-5-5",
  "claude-sonnet-5": "us.anthropic.claude-sonnet-5",
  "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6",
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
 * Each model's documented maximum output, by canonical id. Passed explicitly on the
 * main turns because the providers cannot be relied on to know it: `@ai-sdk/anthropic`
 * falls back to `max_tokens: 4096` for an id it doesn't know, and Bedrock applies its
 * own default when none is sent. With adaptive thinking counted inside the same limit,
 * 4096 truncates a tool-heavy turn. Keyed by the model a turn actually resolved to,
 * so a dashboard override to a smaller model gets that model's limit, not Sonnet's.
 */
export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "claude-sonnet-5-5": 128_000,
  "claude-sonnet-5": 128_000,
  "claude-opus-5": 128_000,
  "claude-sonnet-4-6": 128_000,
  "claude-haiku-4-5": 64_000,
};

/** The output budget for a canonical `"anthropic:<id>"` or bare id; undefined leaves the provider's default. */
export function maxOutputTokensFor(model: string): number | undefined {
  const id = model.startsWith("anthropic:") ? model.slice("anthropic:".length) : model;
  return MODEL_MAX_OUTPUT_TOKENS[id];
}

type CallProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: ReadonlySet<string> = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);

/**
 * How a model's thinking is switched off and tuned, by canonical id.
 *
 * - `off`: the thinking value that turns it off. Sonnet 5.5 rejects `disabled` with a
 *   400 and takes `between_tools` instead: no up-front thinking, and the notes it
 *   writes between tool calls still come back, with their text.
 * - `effort`: the main-turn effort when `DASHBOARD_AGENT_EFFORT` is unset. Sonnet 5.5's
 *   levels are recalibrated from Sonnet 5's, so it gets its own default rather than the
 *   API's `high`. Unset leaves the API default.
 * - `progressUpdates`: the model returns its between-tool-call notes as thinking blocks,
 *   empty unless the request asks for `display: "updates"`.
 */
type ThinkingProfile = {
  off: "disabled" | "between_tools";
  effort?: Effort;
  progressUpdates: boolean;
};

const THINKING_PROFILES: Record<string, ThinkingProfile> = {
  "claude-sonnet-5-5": { off: "between_tools", effort: "medium", progressUpdates: true },
};

const DEFAULT_THINKING_PROFILE: ThinkingProfile = { off: "disabled", progressUpdates: false };

function thinkingProfile(model: string): ThinkingProfile {
  return THINKING_PROFILES[canonicalId(model)] ?? DEFAULT_THINKING_PROFILE;
}

/** The main-turn effort override, or undefined when unset, blank, or not a level. */
function effortOverride(): Effort | undefined {
  const value = process.env.DASHBOARD_AGENT_EFFORT?.trim();
  return value && EFFORTS.has(value) ? (value as Effort) : undefined;
}

/**
 * Provider options for a main turn, and for the head-start step, which must send the
 * same so the prefix it caches stays valid for the run (an effort change invalidates
 * the cache). Carries the effort and, on a model with progress updates, adaptive
 * thinking with `display: "updates"` so the notes between tool calls reach the panel.
 */
export function turnProviderOptions(model: string): CallProviderOptions | undefined {
  const profile = thinkingProfile(model);
  const effort = effortOverride() ?? profile.effort;
  if (!effort && !profile.progressUpdates) return undefined;
  return {
    anthropic: {
      ...(effort && { effort }),
      ...(profile.progressUpdates && { thinking: { type: "adaptive", display: "updates" } }),
    },
  };
}

/**
 * Provider options that keep a bounded call (a summary, a wake) from spending its
 * `maxOutputTokens` on thinking, which counts against the same limit. No effort is
 * sent: `between_tools` is rejected above `high`, and the API default is `high`.
 */
export function withoutThinking(model: string): CallProviderOptions {
  return { anthropic: { thinking: { type: thinkingProfile(model).off } } };
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

/** Merge a breakpoint into a message's provider options. */
export function withCacheBreakpoint(
  providerOptions: ProviderOptions,
  breakpoint: CacheBreakpoint
): Record<string, any> {
  return {
    ...providerOptions,
    [CACHE_BREAKPOINT_KEY]: { kind: breakpoint },
    anthropic: {
      ...providerOptions?.anthropic,
      cacheControl: breakpoint === "prefix" ? PROMPT_CACHE_CONTROL : STEP_CACHE_CONTROL,
    },
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

/** The cache token counts a call reports on its metadata, which both providers key `anthropic`. */
export function cacheUsageFromProviderMetadata(providerMetadata: unknown): {
  write?: number;
  read?: number;
} {
  const metadata = (providerMetadata as Record<string, any> | undefined)?.anthropic;
  const count = (value: unknown) => (typeof value === "number" ? value : undefined);
  return {
    write: count(metadata?.cacheCreationInputTokens),
    read: count(metadata?.cacheReadInputTokens),
  };
}

/** The same options with the breakpoint and its discriminator removed. */
export function withoutCacheBreakpoint(providerOptions: ProviderOptions): Record<string, any> {
  const {
    anthropic: provider,
    [CACHE_BREAKPOINT_KEY]: _tag,
    ...rest
  } = (providerOptions ?? {}) as Record<string, any>;
  const { cacheControl: _dropped, ...providerRest } = (provider ?? {}) as Record<string, any>;
  // An empty provider entry is not the same as no options for it, so drop the key.
  return Object.keys(providerRest).length > 0 ? { ...rest, anthropic: providerRest } : rest;
}
