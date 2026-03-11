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

export type DefaultModelDefinition = {
  modelName: string;
  matchPattern: string;
  startDate?: string;
  pricingTiers: Array<{
    name: string;
    isDefault: boolean;
    priority: number;
    conditions: PricingCondition[];
    prices: Record<string, number>;
  }>;
};
