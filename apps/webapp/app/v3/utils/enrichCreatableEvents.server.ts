import type { CreateEventInput, LlmUsageData } from "../eventRepository/eventRepository.types";

// Registry interface — matches ModelPricingRegistry from @internal/llm-pricing
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

  enrichLlmCost(event);

  return event;
}

function enrichLlmCost(event: CreateEventInput): void {
  const props = event.properties;
  if (!props) return;

  // Only enrich span-like events (INTERNAL, SERVER, CLIENT, CONSUMER, PRODUCER — not LOG, UNSPECIFIED)
  const enrichableKinds = new Set(["INTERNAL", "SERVER", "CLIENT", "CONSUMER", "PRODUCER"]);
  if (!enrichableKinds.has(event.kind as string)) return;

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

  if (!_registry?.isLoaded) {
    return;
  }

  const cost = _registry.calculateCost(responseModel, usageDetails);
  if (!cost) return;

  // Add trigger.llm.* attributes to the span
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

  // Add style accessories for model, tokens, and cost
  const inputTokens = usageDetails["input"] ?? 0;
  const outputTokens = usageDetails["output"] ?? 0;
  const totalTokens = inputTokens + outputTokens;

  event.style = {
    ...event.style,
    accessory: {
      style: "pills",
      items: [
        { text: responseModel, icon: "tabler-cube" },
        { text: formatTokenCount(totalTokens), icon: "tabler-hash" },
        { text: formatCost(cost.totalCost), icon: "tabler-currency-dollar" },
      ],
    },
  };

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

  // Set _llmUsage side-channel for dual-write to llm_usage_v1
  const llmUsage: LlmUsageData = {
    genAiSystem: (props["gen_ai.system"] as string) ?? "unknown",
    requestModel: (props["gen_ai.request.model"] as string) ?? responseModel,
    responseModel,
    matchedModelId: cost.matchedModelId,
    operationName: (props["gen_ai.operation.name"] as string) ?? (props["operation.name"] as string) ?? "",
    pricingTierId: cost.pricingTierId,
    pricingTierName: cost.pricingTierName,
    inputTokens: usageDetails["input"] ?? 0,
    outputTokens: usageDetails["output"] ?? 0,
    totalTokens: Object.values(usageDetails).reduce((sum, v) => sum + v, 0),
    usageDetails,
    inputCost: cost.inputCost,
    outputCost: cost.outputCost,
    totalCost: cost.totalCost,
    costDetails: cost.costDetails,
    metadata,
  };

  event._llmUsage = llmUsage;
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

  // Direct property access and early returns
  // GenAI System check
  const system = props["gen_ai.system"];
  if (typeof system === "string") {
    return { ...baseStyle, icon: `tabler-brand-${system.split(".")[0]}` };
  }

  // Agent workflow check
  const name = props["name"];
  if (typeof name === "string" && name.includes("Agent workflow")) {
    return { ...baseStyle, icon: "tabler-brain" };
  }

  const message = event.message;

  if (typeof message === "string" && message === "ai.toolCall") {
    return { ...baseStyle, icon: "tabler-tool" };
  }

  if (typeof message === "string" && message.startsWith("ai.")) {
    return { ...baseStyle, icon: "tabler-sparkles" };
  }

  return baseStyle;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toString();
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
