import { asSchema, type Tool } from "ai";

/**
 * The cacheable prefix of a dashboard-agent call — the system prompt plus the tool
 * definitions — measured, so a shared cache is provable rather than assumed.
 *
 * Head start makes the first call of a chat in the webapp and the agent task makes
 * every call after it. They only share Anthropic's cache if their prefixes are
 * byte-identical, which is why `tool-schemas.ts` freezes the tool key order. The
 * fingerprint here is what makes a drift visible: equal fingerprints on both sides,
 * shared cache; different fingerprints, every call pays a fresh write.
 *
 * Kept free of heavy imports (only `ai`) so the webapp's head-start path can import
 * it — see the bundle-isolation note in the SDK's `chat-server.ts`.
 */

/**
 * The Anthropic breakpoint every dashboard-agent call uses. 1 hour rather than the
 * 5-minute default: a single turn reads the prefix three to five times, and user
 * think-time between turns routinely exceeds five minutes.
 */
export const PROMPT_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

export type PromptPrefixMeasurement = {
  /** Characters of system text + tool definitions. */
  chars: number;
  /** chars / 4. An estimate — the provider never reports a prefix size. */
  estimatedTokens: number;
  /** Changes iff the cacheable prefix changes. */
  fingerprint: string;
};

const toolDefinitionCache = new WeakMap<object, string>();

/** Just what reaches the provider: name, description, JSON schema, in key order. */
function serializeToolDefinitions(tools: Record<string, Tool<any, any>>): string {
  const cached = toolDefinitionCache.get(tools);
  if (cached !== undefined) return cached;
  const serialized = JSON.stringify(
    Object.entries(tools).map(([name, definition]) => ({
      name,
      description: definition.description ?? "",
      inputSchema: asSchema(definition.inputSchema as never).jsonSchema,
    }))
  );
  toolDefinitionCache.set(tools, serialized);
  return serialized;
}

export function describePromptPrefix(args: {
  system: string;
  tools: Record<string, Tool<any, any>>;
}): PromptPrefixMeasurement {
  const serialized = `${args.system}\u0000${serializeToolDefinitions(args.tools)}`;
  return {
    chars: serialized.length,
    estimatedTokens: Math.round(serialized.length / 4),
    fingerprint: fnv1a32(serialized),
  };
}

/** The prefix split into the two halves that grow independently. */
export type PromptPrefixParts = {
  prompt: { chars: number; estimatedTokens: number };
  tools: { count: number; chars: number; estimatedTokens: number };
  total: PromptPrefixMeasurement;
};

/**
 * The same measurement, itemised. Every call pays for both halves, so a budget has
 * to say which one grew: an edited prompt and four more tools read very differently.
 */
export function describePromptPrefixParts(args: {
  system: string;
  tools: Record<string, Tool<any, any>>;
}): PromptPrefixParts {
  const toolChars = serializeToolDefinitions(args.tools).length;
  return {
    prompt: { chars: args.system.length, estimatedTokens: Math.round(args.system.length / 4) },
    tools: {
      count: Object.keys(args.tools).length,
      chars: toolChars,
      estimatedTokens: Math.round(toolChars / 4),
    },
    total: describePromptPrefix(args),
  };
}

/** FNV-1a, so the fingerprint needs no crypto import in either bundle. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The four numbers a call's cache behaviour is judged on. */
export type PromptCacheUsage = {
  inputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

/**
 * Flattened for a log line, using the `gen_ai.usage.*` names the SDK already puts
 * on the turn span. `null` means the provider didn't report the value — never a
 * substituted zero.
 */
export function promptCacheAttributes(args: {
  source: string;
  usage: PromptCacheUsage | undefined;
  prefix: PromptPrefixMeasurement;
}): Record<string, unknown> {
  const details = args.usage?.inputTokenDetails;
  return {
    "dashboard_agent.prompt_cache.source": args.source,
    "gen_ai.usage.input_tokens": args.usage?.inputTokens ?? null,
    "gen_ai.usage.cache_write_input_tokens": details?.cacheWriteTokens ?? null,
    "gen_ai.usage.cache_read_input_tokens": details?.cacheReadTokens ?? null,
    "gen_ai.usage.uncached_input_tokens": details?.noCacheTokens ?? null,
    // An estimate of the prefix we expect to be cached, and the identity that has to
    // match across the head-start / agent boundary for the cache to be shared.
    "dashboard_agent.prefix.estimated_tokens": args.prefix.estimatedTokens,
    "dashboard_agent.prefix.chars": args.prefix.chars,
    "dashboard_agent.prefix.fingerprint": args.prefix.fingerprint,
  };
}
