// Shared primitive helpers for AI span data extraction

export function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export function tryPrettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

/**
 * Parse provider metadata from a JSON string.
 * Handles Anthropic, Azure, OpenAI, Gateway, and OpenRouter formats.
 */
export function parseProviderMetadata(
  raw: unknown
): {
  serviceTier?: string;
  resolvedProvider?: string;
  gatewayCost?: string;
  responseId?: string;
} | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;

    let serviceTier: string | undefined;
    let resolvedProvider: string | undefined;
    let gatewayCost: string | undefined;
    let responseId: string | undefined;

    // Anthropic: { anthropic: { usage: { service_tier: "standard" } } }
    const anthropic = rec(parsed.anthropic);
    serviceTier = str(rec(anthropic.usage).service_tier);

    // Azure/OpenAI: { azure: { serviceTier: "default" } } or { openai: { serviceTier: "..." } }
    const openai = rec(parsed.openai);
    if (!serviceTier) {
      serviceTier = str(rec(parsed.azure).serviceTier) ?? str(openai.serviceTier);
    }

    // OpenAI response ID
    responseId = str(openai.responseId);

    // Gateway: { gateway: { routing: { finalProvider, resolvedProvider }, cost } }
    const gateway = rec(parsed.gateway);
    const routing = rec(gateway.routing);
    resolvedProvider = str(routing.finalProvider) ?? str(routing.resolvedProvider);
    gatewayCost = str(gateway.cost);

    // OpenRouter: { openrouter: { provider: "xAI" } }
    if (!resolvedProvider) {
      resolvedProvider = str(rec(parsed.openrouter).provider);
    }

    if (!serviceTier && !resolvedProvider && !gatewayCost && !responseId) return undefined;
    return { serviceTier, resolvedProvider, gatewayCost, responseId };
  } catch {
    return undefined;
  }
}

/**
 * Extract user-defined telemetry metadata, coercing non-string values.
 * Skips the "prompt" key which is handled separately.
 */
export function extractTelemetryMetadata(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "prompt") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
