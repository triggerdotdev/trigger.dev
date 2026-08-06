import { logger } from "@trigger.dev/sdk";
import type { ModelMessage, ToolSet } from "ai";
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

export const STEP_CACHE_CONTROL = { type: "ephemeral", ttl: "5m" } as const;

// Anthropic silently refuses to cache a prefix shorter than roughly 1024 tokens.
export const MIN_STEP_CACHE_CHARS = 4_096;

type MaybeCached = { providerOptions?: Record<string, unknown> };

function cacheControlTtl(message: MaybeCached): string | undefined {
  const anthropic = message.providerOptions?.anthropic as
    | { cacheControl?: { ttl?: unknown } }
    | undefined;
  const ttl = anthropic?.cacheControl?.ttl;
  return typeof ttl === "string" ? ttl : undefined;
}

function anthropicOptions(message: MaybeCached): Record<string, unknown> {
  const anthropic = message.providerOptions?.anthropic;
  return typeof anthropic === "object" && anthropic !== null
    ? (anthropic as Record<string, unknown>)
    : {};
}

function withoutStepBreakpoint<T extends MaybeCached>(message: T): T {
  if (cacheControlTtl(message) !== STEP_CACHE_CONTROL.ttl) return message;
  const { anthropic, ...rest } = message.providerOptions as Record<string, unknown>;
  const { cacheControl: _dropped, ...anthropicRest } = anthropic as Record<string, unknown>;
  // An empty `anthropic` is not the same as no Anthropic options, so drop the key.
  const providerOptions =
    Object.keys(anthropicRest).length > 0 ? { ...rest, anthropic: anthropicRest } : rest;
  return { ...message, providerOptions };
}

// Only ever one step breakpoint at a time: Anthropic allows four in total, and the
// system block and the per-turn history breakpoint take two of them.
export function markStepCacheBreakpoint<T extends MaybeCached>(messages: T[]): T[] {
  if (messages.length === 0) return messages;

  let lastLongLived = -1;
  messages.forEach((message, index) => {
    const ttl = cacheControlTtl(message);
    if (ttl !== undefined && ttl !== STEP_CACHE_CONTROL.ttl) lastLongLived = index;
  });
  const tail = messages.slice(lastLongLived + 1);
  if ((JSON.stringify(tail)?.length ?? 0) < MIN_STEP_CACHE_CHARS) {
    return messages.map(withoutStepBreakpoint);
  }

  const stripped = messages.map(withoutStepBreakpoint);
  const last = stripped[stripped.length - 1]!;
  return [
    ...stripped.slice(0, -1),
    {
      ...last,
      providerOptions: {
        ...last.providerOptions,
        anthropic: { ...anthropicOptions(last), cacheControl: STEP_CACHE_CONTROL },
      },
    },
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
  providerMetadata: unknown
): Record<string, unknown> {
  const anthropic = (providerMetadata as { anthropic?: Record<string, unknown> } | undefined)
    ?.anthropic;
  const write = anthropic?.cacheCreationInputTokens;
  const read = anthropic?.cacheReadInputTokens;
  return {
    "dashboard_agent.step": step ?? null,
    "gen_ai.usage.cache_creation_input_tokens": typeof write === "number" ? write : null,
    "gen_ai.usage.cache_read_input_tokens": typeof read === "number" ? read : null,
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
      ...stepCacheAttributes(args.step, args.providerMetadata),
    });
  } catch (error) {
    // Measurement must never fail a turn.
    logger.debug("dashboard-agent prompt cache measurement failed", { error });
  }
}
