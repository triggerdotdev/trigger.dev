import type { Decimal } from "@trigger.dev/database";

export type PricingCondition = {
  usageDetailPattern: string;
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
  value: number;
};

export type LlmPriceEntry = {
  usageType: string;
  price: number;
};

export type LlmPricingTierWithPrices = {
  id: string;
  name: string;
  isDefault: boolean;
  priority: number;
  conditions: PricingCondition[];
  prices: LlmPriceEntry[];
};

export type LlmModelWithPricing = {
  id: string;
  friendlyId: string;
  modelName: string;
  matchPattern: string;
  startDate: Date | null;
  pricingTiers: LlmPricingTierWithPrices[];
};

export type LlmCostResult = {
  matchedModelId: string;
  matchedModelName: string;
  pricingTierId: string;
  pricingTierName: string;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  costDetails: Record<string, number>;
};

export type ModelCatalogEntry = {
  provider: string;
  description: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
  /** ISO date string of when the model was publicly released (e.g. "2025-06-15"). */
  releaseDate: string | null;
  /** Whether the model is deprecated/legacy and should be hidden from the registry by default. */
  isHidden: boolean;
  /** Whether the model supports reliable structured JSON output (schema adherence). */
  supportsStructuredOutput: boolean;
  /** Whether the model can call multiple tools in a single turn. */
  supportsParallelToolCalls: boolean;
  /** Whether the model supports streaming partial tool call results. */
  supportsStreamingToolCalls: boolean;
  /** ISO date string of when the model will be deprecated/sunset, if known. */
  deprecationDate: string | null;
  /** ISO date string of the model's training data cutoff (e.g. "2024-10-01"). */
  knowledgeCutoff: string | null;
  /** ISO timestamp of when this entry was last researched/resolved. */
  resolvedAt: string;
  /** The base model this is a variant of, or null if this IS the base model. */
  baseModelName: string | null;
};

export type DefaultModelDefinition = {
  modelName: string;
  matchPattern: string;
  startDate?: string;
  // Catalog metadata (merged from model-catalog.json during seed)
  provider?: string;
  description?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: string[];
  isHidden?: boolean;
  pricingTiers: Array<{
    name: string;
    isDefault: boolean;
    priority: number;
    conditions: PricingCondition[];
    prices: Record<string, number>;
  }>;
};
