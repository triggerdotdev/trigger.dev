import { describe, it, expect, beforeEach } from "vitest";
import { ModelPricingRegistry } from "./registry.js";
import { defaultModelPrices } from "./defaultPrices.js";
import type { LlmModelWithPricing } from "./types.js";

// Convert POSIX-style (?i) inline flag to JS RegExp 'i' flag
function compilePattern(pattern: string): RegExp {
  if (pattern.startsWith("(?i)")) {
    return new RegExp(pattern.slice(4), "i");
  }
  return new RegExp(pattern);
}

// Create a mock registry that we can load with test data without Prisma
class TestableRegistry extends ModelPricingRegistry {
  loadPatterns(models: LlmModelWithPricing[]) {
    // Access private fields via any cast for testing
    const self = this as any;
    self._patterns = models.map((model) => ({
      regex: compilePattern(model.matchPattern),
      model,
    }));
    self._exactMatchCache = new Map();
    self._loaded = true;
  }
}

const gpt4o: LlmModelWithPricing = {
  id: "model-gpt4o",
  friendlyId: "llm_model_gpt4o",
  modelName: "gpt-4o",
  matchPattern: "^gpt-4o(-\\d{4}-\\d{2}-\\d{2})?$",
  startDate: null,
  pricingTiers: [
    {
      id: "tier-gpt4o-standard",
      name: "Standard",
      isDefault: true,
      priority: 0,
      conditions: [],
      prices: [
        { usageType: "input", price: 0.0000025 },
        { usageType: "output", price: 0.00001 },
        { usageType: "input_cached_tokens", price: 0.00000125 },
      ],
    },
  ],
};

const claudeSonnet: LlmModelWithPricing = {
  id: "model-claude-sonnet",
  friendlyId: "llm_model_claude_sonnet",
  modelName: "claude-sonnet-4-0",
  matchPattern: "^claude-sonnet-4-0(-\\d{8})?$",
  startDate: null,
  pricingTiers: [
    {
      id: "tier-claude-sonnet-standard",
      name: "Standard",
      isDefault: true,
      priority: 0,
      conditions: [],
      prices: [
        { usageType: "input", price: 0.000003 },
        { usageType: "output", price: 0.000015 },
        { usageType: "input_cached_tokens", price: 0.0000015 },
      ],
    },
  ],
};

describe("ModelPricingRegistry", () => {
  let registry: TestableRegistry;

  beforeEach(() => {
    registry = new TestableRegistry(null as any);
    registry.loadPatterns([gpt4o, claudeSonnet]);
  });

  describe("match", () => {
    it("should match exact model name", () => {
      const result = registry.match("gpt-4o");
      expect(result).not.toBeNull();
      expect(result!.modelName).toBe("gpt-4o");
    });

    it("should match model with date suffix", () => {
      const result = registry.match("gpt-4o-2024-08-06");
      expect(result).not.toBeNull();
      expect(result!.modelName).toBe("gpt-4o");
    });

    it("should match claude model", () => {
      const result = registry.match("claude-sonnet-4-0-20250514");
      expect(result).not.toBeNull();
      expect(result!.modelName).toBe("claude-sonnet-4-0");
    });

    it("should return null for unknown model", () => {
      const result = registry.match("unknown-model-xyz");
      expect(result).toBeNull();
    });

    it("should cache exact matches", () => {
      registry.match("gpt-4o");
      registry.match("gpt-4o");
      // Second call should use cache - no way to verify without mocking, but it shouldn't error
      expect(registry.match("gpt-4o")!.modelName).toBe("gpt-4o");
    });

    it("should cache misses", () => {
      expect(registry.match("unknown")).toBeNull();
      expect(registry.match("unknown")).toBeNull();
    });
  });

  describe("calculateCost", () => {
    it("should calculate cost for input and output tokens", () => {
      const result = registry.calculateCost("gpt-4o", {
        input: 1000,
        output: 100,
      });

      expect(result).not.toBeNull();
      expect(result!.matchedModelName).toBe("gpt-4o");
      expect(result!.pricingTierName).toBe("Standard");
      expect(result!.inputCost).toBeCloseTo(0.0025); // 1000 * 0.0000025
      expect(result!.outputCost).toBeCloseTo(0.001); // 100 * 0.00001
      expect(result!.totalCost).toBeCloseTo(0.0035);
    });

    it("should include cached token costs", () => {
      const result = registry.calculateCost("gpt-4o", {
        input: 500,
        output: 50,
        input_cached_tokens: 200,
      });

      expect(result).not.toBeNull();
      expect(result!.costDetails["input"]).toBeCloseTo(0.00125); // 500 * 0.0000025
      expect(result!.costDetails["output"]).toBeCloseTo(0.0005); // 50 * 0.00001
      expect(result!.costDetails["input_cached_tokens"]).toBeCloseTo(0.00025); // 200 * 0.00000125
      expect(result!.totalCost).toBeCloseTo(0.002);
    });

    it("should return null for unknown model", () => {
      const result = registry.calculateCost("unknown-model", { input: 100, output: 50 });
      expect(result).toBeNull();
    });

    it("should handle zero tokens", () => {
      const result = registry.calculateCost("gpt-4o", { input: 0, output: 0 });
      expect(result).not.toBeNull();
      expect(result!.totalCost).toBe(0);
    });

    it("should handle missing usage types gracefully", () => {
      const result = registry.calculateCost("gpt-4o", { input: 100 });
      expect(result).not.toBeNull();
      expect(result!.inputCost).toBeCloseTo(0.00025);
      expect(result!.outputCost).toBe(0); // No output tokens
      expect(result!.totalCost).toBeCloseTo(0.00025);
    });
  });

  describe("isLoaded", () => {
    it("should return false before loading", () => {
      const freshRegistry = new TestableRegistry(null as any);
      expect(freshRegistry.isLoaded).toBe(false);
    });

    it("should return true after loading", () => {
      expect(registry.isLoaded).toBe(true);
    });
  });

  describe("defaultModelPrices (Langfuse JSON)", () => {
    it("should load all models from the JSON file", () => {
      expect(defaultModelPrices.length).toBeGreaterThan(100);
    });

    it("should compile all match patterns without errors", () => {
      const langfuseRegistry = new TestableRegistry(null as any);
      const models: LlmModelWithPricing[] = defaultModelPrices.map((def, i) => ({
        id: `test-${i}`,
        friendlyId: `llm_model_test${i}`,
        modelName: def.modelName,
        matchPattern: def.matchPattern,
        startDate: def.startDate ? new Date(def.startDate) : null,
        pricingTiers: def.pricingTiers.map((tier, j) => ({
          id: `tier-${i}-${j}`,
          name: tier.name,
          isDefault: tier.isDefault,
          priority: tier.priority,
          conditions: tier.conditions,
          prices: Object.entries(tier.prices).map(([usageType, price]) => ({
            usageType,
            price,
          })),
        })),
      }));

      // This should not throw — all 141 patterns should compile
      expect(() => langfuseRegistry.loadPatterns(models)).not.toThrow();
      expect(langfuseRegistry.isLoaded).toBe(true);
    });

    it("should match real-world model names from Langfuse patterns", () => {
      const langfuseRegistry = new TestableRegistry(null as any);
      const models: LlmModelWithPricing[] = defaultModelPrices.map((def, i) => ({
        id: `test-${i}`,
        friendlyId: `llm_model_test${i}`,
        modelName: def.modelName,
        matchPattern: def.matchPattern,
        startDate: null,
        pricingTiers: def.pricingTiers.map((tier, j) => ({
          id: `tier-${i}-${j}`,
          name: tier.name,
          isDefault: tier.isDefault,
          priority: tier.priority,
          conditions: tier.conditions,
          prices: Object.entries(tier.prices).map(([usageType, price]) => ({
            usageType,
            price,
          })),
        })),
      }));
      langfuseRegistry.loadPatterns(models);

      // Test real model strings that SDKs send
      expect(langfuseRegistry.match("gpt-4o")).not.toBeNull();
      expect(langfuseRegistry.match("gpt-4o-mini")).not.toBeNull();
      expect(langfuseRegistry.match("claude-sonnet-4-5-20250929")).not.toBeNull();
      expect(langfuseRegistry.match("claude-sonnet-4-20250514")).not.toBeNull();
    });
  });
});
