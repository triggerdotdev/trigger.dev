import type { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import type {
  LlmModelWithPricing,
  LlmCostResult,
  LlmPricingTierWithPrices,
  PricingCondition,
} from "./types.js";

type CompiledPattern = {
  regex: RegExp;
  model: LlmModelWithPricing;
};

// Convert POSIX-style (?i) inline flag to JS RegExp 'i' flag
function compilePattern(pattern: string): RegExp {
  if (pattern.startsWith("(?i)")) {
    return new RegExp(pattern.slice(4), "i");
  }
  return new RegExp(pattern);
}

export class ModelPricingRegistry {
  private _prisma: PrismaClient | PrismaReplicaClient;
  private _patterns: CompiledPattern[] = [];
  // TODO: When we add project-based models (users adding their own), this cache grows unbounded
  // between reloads. Fine-tuned model IDs (e.g. "ft:gpt-3.5-turbo:org:name:id") create unique
  // entries per model string. Consider adding an LRU cap or size limit at that point.
  private _exactMatchCache: Map<string, LlmModelWithPricing | null> = new Map();
  private _loaded = false;
  private _readyResolve!: () => void;

  /** Resolves once the initial `loadFromDatabase()` completes successfully. */
  readonly isReady: Promise<void>;

  constructor(prisma: PrismaClient | PrismaReplicaClient) {
    this._prisma = prisma;
    this.isReady = new Promise<void>((resolve) => {
      this._readyResolve = resolve;
    });
  }

  get isLoaded(): boolean {
    return this._loaded;
  }

  async loadFromDatabase(): Promise<void> {
    const models = await this._prisma.llmModel.findMany({
      where: { projectId: null },
      include: {
        pricingTiers: {
          include: { prices: true },
          orderBy: { priority: "asc" },
        },
      },
      orderBy: [{ startDate: "desc" }],
    });

    const compiled: CompiledPattern[] = [];

    for (const model of models) {
      try {
        const regex = compilePattern(model.matchPattern);
        const tiers: LlmPricingTierWithPrices[] = model.pricingTiers.map((tier) => ({
          id: tier.id,
          name: tier.name,
          isDefault: tier.isDefault,
          priority: tier.priority,
          conditions: (tier.conditions as PricingCondition[]) ?? [],
          prices: tier.prices.map((p) => ({
            usageType: p.usageType,
            price: Number(p.price),
          })),
        }));

        compiled.push({
          regex,
          model: {
            id: model.id,
            friendlyId: model.friendlyId,
            modelName: model.modelName,
            matchPattern: model.matchPattern,
            startDate: model.startDate,
            pricingTiers: tiers,
          },
        });
      } catch {
        // Skip models with invalid regex patterns
        console.warn(`Invalid regex pattern for model ${model.modelName}: ${model.matchPattern}`);
      }
    }

    this._patterns = compiled;
    this._exactMatchCache.clear();

    if (!this._loaded) {
      this._loaded = true;
      this._readyResolve();
    }
  }

  async reload(): Promise<void> {
    await this.loadFromDatabase();
  }

  match(responseModel: string): LlmModelWithPricing | null {
    if (!this._loaded) return null;

    // Check exact match cache
    const cached = this._exactMatchCache.get(responseModel);
    if (cached !== undefined) return cached;

    // Iterate compiled regex patterns
    for (const { regex, model } of this._patterns) {
      if (regex.test(responseModel)) {
        this._exactMatchCache.set(responseModel, model);
        return model;
      }
    }

    // Fallback: strip provider prefix (e.g. "mistral/mistral-large-3" → "mistral-large-3")
    // Gateway and OpenRouter prepend the provider to the model name.
    if (responseModel.includes("/")) {
      const stripped = responseModel.split("/").slice(1).join("/");
      for (const { regex, model } of this._patterns) {
        if (regex.test(stripped)) {
          this._exactMatchCache.set(responseModel, model);
          return model;
        }
      }
    }

    // Cache miss
    this._exactMatchCache.set(responseModel, null);
    return null;
  }

  calculateCost(
    responseModel: string,
    usageDetails: Record<string, number>
  ): LlmCostResult | null {
    const model = this.match(responseModel);
    if (!model) return null;

    const tier = this._matchPricingTier(model.pricingTiers, usageDetails);
    if (!tier) return null;

    const costDetails: Record<string, number> = {};
    let totalCost = 0;

    // `input_tokens` (the "input" usage value) is the TOTAL prompt token count and is
    // inclusive of cache-read and cache-creation tokens — providers report it that way and
    // the AI SDK passes it through (verified: total_tokens == input + output, never the
    // sum of the decomposed parts). Cache reads/writes are therefore a SUBSET of input, not
    // additional to it. Charging the full input count at the input price AND charging a
    // separate cache line double-counts those tokens, so the input price must apply only to
    // the fresh (non-cached) remainder.
    const priceByType = new Map(tier.prices.map((p) => [p.usageType, p.price]));
    const resolvePrice = (aliases: string[]): number | undefined => {
      for (const alias of aliases) {
        const price = priceByType.get(alias);
        if (price !== undefined) return price;
      }
      return undefined;
    };

    const inputPrice = resolvePrice(["input", "input_tokens"]) ?? 0;
    const cacheReadTokens = usageDetails["input_cached_tokens"] ?? 0;
    const cacheCreationTokens = usageDetails["cache_creation_input_tokens"] ?? 0;

    // Providers price cache reads/writes under provider-specific keys, but our usage details
    // normalize them to `input_cached_tokens` / `cache_creation_input_tokens`. Resolve the
    // matching price across the known aliases, falling back to the input price so cache tokens
    // are never billed for free and never dropped when a model lacks a dedicated cache price.
    const cacheReadPrice =
      resolvePrice(["input_cached_tokens", "input_cache_read", "cache_read_input_tokens"]) ??
      inputPrice;
    const cacheCreationPrice =
      resolvePrice([
        "cache_creation_input_tokens",
        "input_cache_creation",
        "input_cache_creation_5m",
        "input_cache_creation_1h",
      ]) ?? inputPrice;

    const totalInputTokens = usageDetails["input"] ?? usageDetails["input_tokens"] ?? 0;
    const freshInputTokens = Math.max(0, totalInputTokens - cacheReadTokens - cacheCreationTokens);

    const addCost = (usageType: string, tokenCount: number, price: number) => {
      if (tokenCount <= 0 || price <= 0) return;
      const cost = tokenCount * price;
      costDetails[usageType] = (costDetails[usageType] ?? 0) + cost;
      totalCost += cost;
    };

    addCost("input", freshInputTokens, inputPrice);
    addCost("input_cached_tokens", cacheReadTokens, cacheReadPrice);
    addCost("cache_creation_input_tokens", cacheCreationTokens, cacheCreationPrice);

    // Charge every remaining usage type generically. The input + cache types are handled
    // above (and their alias keys skipped here) so they are never charged twice.
    const handledUsageTypes = new Set([
      "input",
      "input_tokens",
      "input_cached_tokens",
      "input_cache_read",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "input_cache_creation",
      "input_cache_creation_5m",
      "input_cache_creation_1h",
    ]);
    for (const priceEntry of tier.prices) {
      if (handledUsageTypes.has(priceEntry.usageType)) continue;
      const tokenCount = usageDetails[priceEntry.usageType] ?? 0;
      if (tokenCount === 0) continue;
      const cost = tokenCount * priceEntry.price;
      costDetails[priceEntry.usageType] = cost;
      totalCost += cost;
    }

    const inputCost = costDetails["input"] ?? 0;
    const outputCost = costDetails["output"] ?? 0;

    return {
      matchedModelId: model.friendlyId,
      matchedModelName: model.modelName,
      pricingTierId: tier.id,
      pricingTierName: tier.name,
      inputCost,
      outputCost,
      totalCost,
      costDetails,
    };
  }

  private _matchPricingTier(
    tiers: LlmPricingTierWithPrices[],
    usageDetails: Record<string, number>
  ): LlmPricingTierWithPrices | null {
    if (tiers.length === 0) return null;

    // Tiers are sorted by priority ascending (lowest first).
    // First pass: evaluate tiers that have conditions — first match wins.
    for (const tier of tiers) {
      if (tier.conditions.length > 0 && this._evaluateConditions(tier.conditions, usageDetails)) {
        return tier;
      }
    }

    // Second pass: fall back to the default tier, or first tier with no conditions
    const defaultTier = tiers.find((t) => t.isDefault);
    if (defaultTier) return defaultTier;

    const unconditional = tiers.find((t) => t.conditions.length === 0);
    return unconditional ?? tiers[0] ?? null;
  }

  private _evaluateConditions(
    conditions: PricingCondition[],
    usageDetails: Record<string, number>
  ): boolean {
    return conditions.every((condition) => {
      // Find matching usage detail key
      const regex = new RegExp(condition.usageDetailPattern);
      const matchingValue = Object.entries(usageDetails).find(([key]) => regex.test(key));
      const value = matchingValue?.[1] ?? 0;

      switch (condition.operator) {
        case "gt":
          return value > condition.value;
        case "gte":
          return value >= condition.value;
        case "lt":
          return value < condition.value;
        case "lte":
          return value <= condition.value;
        case "eq":
          return value === condition.value;
        case "neq":
          return value !== condition.value;
        default:
          return false;
      }
    });
  }
}
