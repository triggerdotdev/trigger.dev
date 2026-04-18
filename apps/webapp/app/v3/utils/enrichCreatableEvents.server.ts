import { modelCatalog } from "@internal/llm-model-catalog";
import { metrics } from "@opentelemetry/api";
import type { CreateEventInput, LlmMetricsData } from "../eventRepository/eventRepository.types";

// Registry interface — matches ModelPricingRegistry from @internal/llm-model-catalog
type CostRegistry = {
  isLoaded: boolean;
  calculateCost(
    responseModel: string,
    usageDetails: Record<string, number>
  ): {
    matchedModelId: string;
    matchedModelName: string;
    pricingTierId: string;
    pricingTierName: string;
    inputCost: number;
    outputCost: number;
    totalCost: number;
    costDetails: Record<string, number>;
  } | null;
};

let _registry: CostRegistry | undefined;

const ENRICHABLE_KINDS = new Set(["INTERNAL", "SERVER", "CLIENT", "CONSUMER", "PRODUCER"]);

// Low-cardinality allowlist of gen_ai.system values. Anything outside this set
// is collapsed into "other" to keep the metric cardinality bounded. Keep in
// sync with the OpenTelemetry GenAI semantic conventions.
const KNOWN_GEN_AI_SYSTEMS = new Set([
  "openai",
  "anthropic",
  "google",
  "vertex_ai",
  "aws.bedrock",
  "az.ai.openai",
  "az.ai.inference",
  "cohere",
  "deepseek",
  "groq",
  "ibm.watsonx.ai",
  "mistral_ai",
  "perplexity",
  "xai",
]);

function normalizeGenAiSystem(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  const normalized = value.toLowerCase();
  return KNOWN_GEN_AI_SYSTEMS.has(normalized) ? normalized : "other";
}

// Emits a metric whenever we see an LLM span with usage data but can't resolve
// a price from the in-memory registry. Used by the llm-registry productionization
// pipeline to detect missing models without having to query ClickHouse.
const llmMeter = metrics.getMeter("trigger.dev.llm_registry", "1.0.0");
const missingModelCounter = llmMeter.createCounter("llm_missing_model_enrichment", {
  description:
    "LLM spans with gen_ai.response.model + usage data that could not be priced by the registry",
});

export function setLlmPricingRegistry(registry: CostRegistry): void {
  _registry = registry;
}

export function enrichCreatableEvents(events: CreateEventInput[]) {
  return events.map((event) => {
    return enrichCreatableEvent(event);
  });
}

function enrichCreatableEvent(event: CreateEventInput): CreateEventInput {
  const message = formatPythonStyle(event.message, event.properties);

  event.message = message;
  event.style = enrichStyle(event);

  enrichLlmMetrics(event);
  enrichPromptResolve(event);

  return event;
}

function enrichLlmMetrics(event: CreateEventInput): void {
  const props = event.properties;
  if (!props) return;

  // Only enrich span-like events (INTERNAL, SERVER, CLIENT, CONSUMER, PRODUCER — not LOG, UNSPECIFIED)
  if (!ENRICHABLE_KINDS.has(event.kind as string)) return;

  // Skip partial spans (they don't have final token counts)
  if (event.isPartial) return;

  // Only use gen_ai.* attributes for model resolution to avoid double-counting.
  // The Vercel AI SDK emits both a parent span (ai.streamText with ai.usage.*)
  // and a child span (ai.streamText.doStream with gen_ai.*). We only enrich the
  // child span that has the canonical gen_ai.response.model attribute.
  const responseModel =
    typeof props["gen_ai.response.model"] === "string"
      ? props["gen_ai.response.model"]
      : typeof props["gen_ai.request.model"] === "string"
        ? props["gen_ai.request.model"]
        : null;

  if (!responseModel) {
    return;
  }

  // Extract usage details, normalizing attribute names
  const usageDetails = extractUsageDetails(props);

  // Need at least some token usage
  const hasTokens = Object.values(usageDetails).some((v) => v > 0);
  if (!hasTokens) {
    return;
  }

  // Add style accessories for model and tokens (even without cost data)
  const inputTokens = usageDetails["input"] ?? 0;
  const outputTokens = usageDetails["output"] ?? 0;
  const totalTokens = usageDetails["total"] ?? inputTokens + outputTokens;

  const pillItems: Array<{ text: string; icon: string }> = [
    { text: responseModel, icon: "tabler-cube" },
    { text: formatTokenCount(totalTokens), icon: "tabler-hash" },
  ];

  // Try cost enrichment if the registry is loaded.
  // The registry handles prefix stripping (e.g. "mistral/mistral-large-3" → "mistral-large-3")
  // for gateway/openrouter models automatically in its match() method.
  let cost: ReturnType<NonNullable<typeof _registry>["calculateCost"]> | null = null;
  if (_registry?.isLoaded) {
    cost = _registry.calculateCost(responseModel, usageDetails);
  }

  // Always extract provider-reported cost when present (gateway/openrouter).
  // Used two ways:
  //   1. As a fallback total_cost when the registry can't price the span.
  //   2. As a drift signal — llm_metrics_v1.provider_cost is compared against
  //      llm_metrics_v1.total_cost by the llm.detect-pricing-drift trigger.dev
  //      task to catch stale registry prices.
  const providerCost = extractProviderCost(props);

  // Observability: if the registry is loaded but couldn't price this span, emit
  // a low-cardinality counter so the productionization pipeline can detect
  // missing models without hitting ClickHouse. We tag by gen_ai.system (bounded
  // enum) and whether a provider-reported cost rescued the span.
  if (_registry?.isLoaded && !cost) {
    missingModelCounter.add(1, {
      gen_ai_system: normalizeGenAiSystem(props["gen_ai.system"]),
      has_provider_cost: providerCost !== null,
    });
  }

  if (cost) {
    // Add trigger.llm.* attributes to the span from our pricing registry
    event.properties = {
      ...props,
      "trigger.llm.input_cost": cost.inputCost,
      "trigger.llm.output_cost": cost.outputCost,
      "trigger.llm.total_cost": cost.totalCost,
      "trigger.llm.matched_model": cost.matchedModelName,
      "trigger.llm.matched_model_id": cost.matchedModelId,
      "trigger.llm.pricing_tier": cost.pricingTierName,
      "trigger.llm.pricing_tier_id": cost.pricingTierId,
    };

    pillItems.push({ text: formatCost(cost.totalCost), icon: "tabler-currency-dollar" });
  } else if (providerCost) {
    // Use provider-reported cost as fallback (no input/output breakdown available)
    event.properties = {
      ...props,
      "trigger.llm.total_cost": providerCost.totalCost,
      "trigger.llm.cost_source": providerCost.source,
    };

    pillItems.push({ text: formatCost(providerCost.totalCost), icon: "tabler-currency-dollar" });
  }

  event.style = {
    ...(event.style as Record<string, unknown> | undefined),
    accessory: {
      style: "pills",
      items: pillItems,
    },
  } as unknown as typeof event.style;

  // Only write llm_metrics when cost data is available
  if (!cost && !providerCost) return;

  // Build metadata map from run tags and ai.telemetry.metadata.*
  const metadata: Record<string, string> = {};

  if (event.runTags) {
    for (const tag of event.runTags) {
      const colonIdx = tag.indexOf(":");
      if (colonIdx > 0) {
        metadata[tag.substring(0, colonIdx)] = tag.substring(colonIdx + 1);
      }
    }
  }

  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("ai.telemetry.metadata.") && typeof value === "string") {
      metadata[key.slice("ai.telemetry.metadata.".length)] = value;
    }
  }

  // Extract new performance/behavioral fields
  const finishReason = typeof props["ai.response.finishReason"] === "string"
    ? props["ai.response.finishReason"]
    : typeof props["gen_ai.response.finish_reasons"] === "string"
      ? props["gen_ai.response.finish_reasons"]
      : "";
  const operationId = typeof props["ai.operationId"] === "string"
    ? props["ai.operationId"]
    : typeof props["gen_ai.operation.name"] === "string"
      ? props["gen_ai.operation.name"]
      : typeof props["operation.name"] === "string"
        ? props["operation.name"]
        : "";
  const msToFirstChunk = typeof props["ai.response.msToFirstChunk"] === "number"
    ? props["ai.response.msToFirstChunk"]
    : 0;
  const avgTokensPerSec = typeof props["ai.response.avgOutputTokensPerSecond"] === "number"
    ? props["ai.response.avgOutputTokensPerSecond"]
    : 0;
  const costSource = cost ? "registry" : providerCost ? providerCost.source : "";
  const providerCostValue = providerCost?.totalCost ?? 0;

  // Set _llmMetrics side-channel for dual-write to llm_metrics_v1
  const llmMetrics: LlmMetricsData = {
    genAiSystem: typeof props["gen_ai.system"] === "string" ? props["gen_ai.system"] : "unknown",
    requestModel: typeof props["gen_ai.request.model"] === "string" ? props["gen_ai.request.model"] : responseModel,
    responseModel,
    baseResponseModel: modelCatalog[responseModel]?.baseModelName ?? responseModel,
    matchedModelId: cost?.matchedModelId ?? "",
    operationId,
    finishReason,
    costSource,
    pricingTierId: cost?.pricingTierId ?? (providerCost ? `provider:${providerCost.source}` : ""),
    pricingTierName: cost?.pricingTierName ?? (providerCost ? `${providerCost.source} reported` : ""),
    inputTokens: usageDetails["input"] ?? 0,
    outputTokens: usageDetails["output"] ?? 0,
    totalTokens: usageDetails["total"] ?? (usageDetails["input"] ?? 0) + (usageDetails["output"] ?? 0),
    usageDetails,
    inputCost: cost?.inputCost ?? 0,
    outputCost: cost?.outputCost ?? 0,
    totalCost: cost?.totalCost ?? providerCost?.totalCost ?? 0,
    costDetails: cost?.costDetails ?? {},
    providerCost: providerCostValue,
    msToFirstChunk,
    tokensPerSecond: avgTokensPerSec,
    metadata,
    promptSlug: metadata["prompt.slug"] ?? "",
    promptVersion: parseInt(metadata["prompt.version"] ?? "0", 10) || 0,
  };

  event._llmMetrics = llmMetrics;
}

function extractUsageDetails(props: Record<string, unknown>): Record<string, number> {
  const details: Record<string, number> = {};

  // Only map gen_ai.usage.* attributes — NOT ai.usage.* from parent spans.
  // This prevents double-counting when both parent (ai.streamText) and child
  // (ai.streamText.doStream) spans carry token counts.
  const mappings: Record<string, string> = {
    "gen_ai.usage.input_tokens": "input",
    "gen_ai.usage.output_tokens": "output",
    "gen_ai.usage.prompt_tokens": "input",
    "gen_ai.usage.completion_tokens": "output",
    "gen_ai.usage.total_tokens": "total",
    "gen_ai.usage.cache_read_input_tokens": "input_cached_tokens",
    "gen_ai.usage.input_tokens_cache_read": "input_cached_tokens",
    "gen_ai.usage.cache_creation_input_tokens": "cache_creation_input_tokens",
    "gen_ai.usage.input_tokens_cache_write": "cache_creation_input_tokens",
    "gen_ai.usage.reasoning_tokens": "reasoning_tokens",
  };

  for (const [attrKey, usageKey] of Object.entries(mappings)) {
    const value = props[attrKey];
    if (typeof value === "number" && value > 0) {
      // Don't overwrite if already set (first mapping wins)
      if (details[usageKey] === undefined) {
        details[usageKey] = value;
      }
    }
  }

  return details;
}

function enrichStyle(event: CreateEventInput) {
  const baseStyle = event.style ?? {};
  const props = event.properties;

  if (!props) {
    return baseStyle;
  }

  const system = props["gen_ai.system"];
  const modelId = props["gen_ai.request.model"] ?? props["ai.model.id"];

  const provider = resolveAiProvider(
    typeof system === "string" ? system : undefined,
    typeof modelId === "string" ? modelId : undefined
  );

  if (provider) {
    return { ...baseStyle, icon: `ai-provider-${provider}` };
  }

  // Agent workflow check
  const name = props["name"];
  if (typeof name === "string" && name.includes("Agent workflow")) {
    return { ...baseStyle, icon: "tabler-brain" };
  }

  const message = event.message;

  if (typeof message === "string" && message === "ai.toolCall") {
    return { ...baseStyle, icon: "hero-wrench" };
  }

  if (typeof message === "string" && message.startsWith("ai.")) {
    return { ...baseStyle, icon: "hero-sparkles" };
  }

  return baseStyle;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toString();
}

/**
 * Extract provider-reported cost from ai.response.providerMetadata.
 * Gateway and OpenRouter include per-request cost in their metadata.
 */
function extractProviderCost(
  props: Record<string, unknown>
): { totalCost: number; source: string } | null {
  const rawMeta = props["ai.response.providerMetadata"];
  if (typeof rawMeta !== "string") return null;

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(rawMeta) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!meta || typeof meta !== "object") return null;

  // Gateway: { gateway: { cost: "0.0006615" } }
  const gateway = meta.gateway;
  if (gateway && typeof gateway === "object") {
    const gw = gateway as Record<string, unknown>;
    const cost = parseFloat(String(gw.cost ?? "0"));
    if (cost > 0) return { totalCost: cost, source: "gateway" };
  }

  // OpenRouter: { openrouter: { usage: { cost: 0.000135 } } }
  const openrouter = meta.openrouter;
  if (openrouter && typeof openrouter === "object") {
    const or = openrouter as Record<string, unknown>;
    const usage = or.usage;
    if (usage && typeof usage === "object") {
      const cost = Number((usage as Record<string, unknown>).cost ?? 0);
      if (cost > 0) return { totalCost: cost, source: "openrouter" };
    }
  }

  return null;
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}

function repr(value: any): string {
  if (typeof value === "string") {
    return `'${value}'`;
  }
  return String(value);
}

function formatPythonStyle(template: string, values: Record<string, any>): string {
  // Early return if template is too long
  if (template.length >= 256) {
    return template;
  }

  // Early return if no template variables present
  if (!template.includes("{")) {
    return template;
  }

  return template.replace(/\{([^}]+?)(?:!r)?\}/g, (match, key) => {
    const hasRepr = match.endsWith("!r}");
    const actualKey = hasRepr ? key : key;
    const value = values?.[actualKey];

    if (value === undefined) {
      return match;
    }

    return hasRepr ? repr(value) : String(value);
  });
}

type AiProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "llama"
  | "deepseek"
  | "xai"
  | "perplexity"
  | "cerebras"
  | "azure"
  | "mistral";

const systemToProvider: Record<string, AiProvider> = {
  anthropic: "anthropic",
  openai: "openai",
  azure: "azure",
  "google.generative-ai": "gemini",
  google: "gemini",
  xai: "xai",
  deepseek: "deepseek",
  cerebras: "cerebras",
  perplexity: "perplexity",
  "meta-llama": "llama",
  mistral: "mistral",
};

const modelPatterns: [RegExp, AiProvider][] = [
  [/\banthropic\b|claude/i, "anthropic"],
  [/\bopenai\b|gpt-|o[134]-|chatgpt/i, "openai"],
  [/gemini/i, "gemini"],
  [/llama/i, "llama"],
  [/deepseek/i, "deepseek"],
  [/grok/i, "xai"],
  [/sonar/i, "perplexity"],
  [/cerebras/i, "cerebras"],
  [/mistral|mixtral|codestral|pixtral/i, "mistral"],
];

function resolveAiProvider(
  system: string | undefined,
  modelId: string | undefined
): AiProvider | undefined {
  if (modelId) {
    if (modelId.includes("/")) {
      const prefix = modelId.split("/")[0].toLowerCase();
      const fromPrefix = systemToProvider[prefix];
      if (fromPrefix) return fromPrefix;
    }

    for (const [pattern, provider] of modelPatterns) {
      if (pattern.test(modelId)) return provider;
    }
  }

  if (system) {
    const normalized = system.toLowerCase().split(".")[0];
    return systemToProvider[system] ?? systemToProvider[normalized];
  }

  return undefined;
}

function enrichPromptResolve(event: CreateEventInput): void {
  const props = event.properties;
  if (!props) return;

  const slug = props["prompt.slug"];
  const version = props["prompt.version"];

  if (typeof slug !== "string") return;

  const style = (event.style ?? {}) as Record<string, unknown>;
  const accessory = style.accessory as Record<string, unknown> | undefined;
  const existingItems =
    accessory && "items" in accessory
      ? (accessory.items as Array<{ text: string; icon?: string; variant?: string }>)
      : [];

  const items = [
    ...existingItems,
    {
      text: `${slug}${typeof version === "number" ? ` v${version}` : ""}`,
      icon: "tabler-file-text-ai",
    },
  ];

  event.style = {
    ...style,
    icon: style.icon ?? "tabler-file-text-ai",
    accessory: { style: "pills" as const, items },
  } as unknown as typeof event.style;
}
