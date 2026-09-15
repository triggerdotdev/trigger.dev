import { logger } from "@trigger.dev/sdk";
import type { ModelMessage, ToolSet } from "ai";
import {
  cacheUsageFromProviderMetadata,
  isLongLivedCacheBreakpoint,
  isStepCacheBreakpoint,
  withCacheBreakpoint,
  withoutCacheBreakpoint,
} from "./model-provider";
import {
  describePromptPrefix,
  promptCacheAttributes,
  type PromptCacheUsage,
} from "./prompt-prefix";

/**
 * The rolling within-turn cache breakpoint, and the per-step telemetry that shows
 * whether the provider honoured it.
 *
 * Shared by every multi-step `streamText` the agent runs — the user's own turn and
 * the consented watch investigation — so a ten-step investigation doesn't re-send
 * its accumulated tool outputs uncached on every step.
 */

export { STEP_CACHE_CONTROL } from "./model-provider";

// Anthropic silently refuses to cache a prefix shorter than roughly 1024 tokens.
export const MIN_STEP_CACHE_CHARS = 4_096;

type MaybeCached = { providerOptions?: Record<string, unknown> };

function withoutStepBreakpoint<T extends MaybeCached>(message: T): T {
  if (!isStepCacheBreakpoint(message.providerOptions)) return message;
  return { ...message, providerOptions: withoutCacheBreakpoint(message.providerOptions) };
}

// Only ever one step breakpoint at a time: Anthropic allows four in total, and the
// system block and the per-turn history breakpoint take two of them.
export function markStepCacheBreakpoint<T extends MaybeCached>(messages: T[]): T[] {
  if (messages.length === 0) return messages;

  let lastLongLived = -1;
  messages.forEach((message, index) => {
    if (isLongLivedCacheBreakpoint(message.providerOptions)) lastLongLived = index;
  });
  const tail = messages.slice(lastLongLived + 1);
  if ((JSON.stringify(tail)?.length ?? 0) < MIN_STEP_CACHE_CHARS) {
    return messages.map(withoutStepBreakpoint);
  }

  const stripped = messages.map(withoutStepBreakpoint);
  const last = stripped[stripped.length - 1]!;
  return [
    ...stripped.slice(0, -1),
    { ...last, providerOptions: withCacheBreakpoint(last.providerOptions, "step") },
  ];
}

type PrepareStepArgs = { messages: ModelMessage[] };
type PrepareStepResult = { messages?: ModelMessage[] } | undefined;
export type PrepareStepFn = (args: never) => PrepareStepResult | Promise<PrepareStepResult>;

export function withStepCacheBreakpoint(inner: PrepareStepFn | undefined): PrepareStepFn {
  return (async (args: PrepareStepArgs) => {
    const base = await inner?.(args as never);
    const messages = base?.messages ?? args.messages;
    return { ...base, messages: markStepCacheBreakpoint(messages) };
  }) as PrepareStepFn;
}

/** Wraps whatever `prepareStep` the resolved options carry, rather than replacing it. */
export function stepCachePrepareStep(options: unknown): PrepareStepFn {
  return withStepCacheBreakpoint(
    (options as { prepareStep?: PrepareStepFn } | undefined)?.prepareStep
  );
}

export function stepCacheAttributes(
  step: number | undefined,
  providerMetadata: unknown,
  usage?: PromptCacheUsage
): Record<string, unknown> {
  const { write, read } = cacheUsageFromProviderMetadata(providerMetadata);
  return {
    "dashboard_agent.step": step ?? null,
    "gen_ai.usage.cache_creation_input_tokens":
      write ?? usage?.inputTokenDetails?.cacheWriteTokens ?? null,
    "gen_ai.usage.cache_read_input_tokens":
      read ?? usage?.inputTokenDetails?.cacheReadTokens ?? null,
  };
}

/**
 * One line per model call: what the provider billed as a cache write, a cache read
 * and uncached input, against the prefix we expect to be cached. The estimate and
 * the fingerprint are ours; the token counts are the provider's, and are logged as
 * `null` when it reported none.
 */
export function recordPromptCacheUsage(args: {
  source: string;
  usage: PromptCacheUsage | undefined;
  system: string;
  tools: ToolSet;
  step?: number;
  providerMetadata?: unknown;
}): void {
  try {
    logger.info("dashboard-agent prompt cache", {
      ...promptCacheAttributes({
        source: args.source,
        usage: args.usage,
        prefix: describePromptPrefix({ system: args.system, tools: args.tools }),
      }),
      ...stepCacheAttributes(args.step, args.providerMetadata, args.usage),
    });
  } catch (error) {
    // Measurement must never fail a turn.
    logger.debug("dashboard-agent prompt cache measurement failed", { error });
  }
}
