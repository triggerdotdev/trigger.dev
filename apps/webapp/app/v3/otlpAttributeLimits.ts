export type AttributeValue = string | number | boolean | undefined;
export type AttributeMap = Record<string, AttributeValue>;

export type AttributeKeyOverride = { prefix: string; limit: number };

export type SpanAttributeLimits = {
  defaultValueLengthLimit: number;
  aiContentValueLengthLimit: number;
  totalAttributesLengthLimit: number;
};

export const AI_CONTENT_KEY_OVERRIDES = (limit: number): AttributeKeyOverride[] => [
  { prefix: "ai.prompt", limit },
  { prefix: "ai.response.text", limit },
  { prefix: "ai.response.object", limit },
  { prefix: "ai.response.toolCalls", limit },
  { prefix: "ai.response.reasoning", limit },
  { prefix: "ai.response.reasoningDetails", limit },
  { prefix: "gen_ai.prompt", limit },
  { prefix: "gen_ai.completion", limit },
  { prefix: "gen_ai.request.messages", limit },
  { prefix: "gen_ai.response.text", limit },
];

export const AI_CONTENT_DROP_PRIORITY: string[] = [
  "ai.prompt.messages",
  "ai.prompt",
  "ai.response.object",
  "ai.response.text",
  "ai.response.toolCalls",
  "ai.response.reasoning",
  "ai.response.reasoningDetails",
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.request.messages",
  "gen_ai.response.text",
];

function matchPrefix(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(prefix + ".");
}

function getMatchingOverride(key: string, overrides: AttributeKeyOverride[]): number | null {
  for (const { prefix, limit } of overrides) {
    if (matchPrefix(key, prefix)) return limit;
  }
  return null;
}

function truncateValue(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

export function truncateAttributes(
  attributes: AttributeMap,
  limits: SpanAttributeLimits,
  overrides: AttributeKeyOverride[]
): AttributeMap {
  const result: AttributeMap = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== "string") {
      result[key] = value;
      continue;
    }

    const override = getMatchingOverride(key, overrides);
    const limit = override ?? limits.defaultValueLengthLimit;
    result[key] = truncateValue(value, limit);
  }

  return result;
}

export function applyTotalSizeBackstop(
  attributes: AttributeMap,
  limits: SpanAttributeLimits,
  dropPriority: string[]
): AttributeMap {
  const json = JSON.stringify(attributes);
  if (json.length <= limits.totalAttributesLengthLimit) return attributes;

  const result: AttributeMap = { ...attributes };
  const aiKeys = new Set<string>();

  for (const key of Object.keys(result)) {
    for (const prefix of dropPriority) {
      if (matchPrefix(key, prefix)) {
        aiKeys.add(key);
        break;
      }
    }
  }

  const sortedAiKeys = dropPriority.filter((k) => aiKeys.has(k));

  for (const key of sortedAiKeys) {
    delete result[key];
    const remainingJson = JSON.stringify(result);
    if (remainingJson.length <= limits.totalAttributesLengthLimit) break;
  }

  return result;
}

export function truncateSpanAttributes(
  attributes: AttributeMap,
  limits: SpanAttributeLimits
): AttributeMap {
  const overrides = AI_CONTENT_KEY_OVERRIDES(limits.aiContentValueLengthLimit);
  let result = truncateAttributes(attributes, limits, overrides);
  result = applyTotalSizeBackstop(result, limits, AI_CONTENT_DROP_PRIORITY);
  return result;
}