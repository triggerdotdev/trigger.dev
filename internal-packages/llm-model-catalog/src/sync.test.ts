import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { defaultModelPrices } from "./defaultPrices.js";
import { modelCatalog } from "./modelCatalog.js";
import { syncLlmCatalog } from "./sync.js";

function getGpt4oDefinition() {
  const def = defaultModelPrices.find((m) => m.modelName === "gpt-4o");
  if (def === undefined) {
    throw new Error("expected gpt-4o in defaultModelPrices");
  }
  return def;
}

const gpt4oDef = getGpt4oDefinition();

function getGeminiProDefinition() {
  const def = defaultModelPrices.find((m) => m.modelName === "gemini-pro");
  if (def === undefined) {
    throw new Error("expected gemini-pro in defaultModelPrices");
  }
  return def;
}

const geminiProDef = getGeminiProDefinition();

/** If sync used `catalog?.baseModelName ?? existing.baseModelName`, sync would keep this string instead of clearing to null. */
const STALE_BASE_MODEL_NAME = "wrong-base-model-sentinel";

const STALE_INPUT_PRICE = 0.099;
const STALE_OUTPUT_PRICE = 0.088;

async function createGpt4oWithStalePricing(
  prisma: PrismaClient,
  source: "default" | "admin"
) {
  const model = await prisma.llmModel.create({
    data: {
      friendlyId: generateFriendlyId("llm_model"),
      projectId: null,
      modelName: gpt4oDef.modelName,
      matchPattern: "^stale-pattern$",
      startDate: gpt4oDef.startDate ? new Date(gpt4oDef.startDate) : null,
      source,
      provider: "stale-provider",
      description: "stale description",
      contextWindow: 111,
      maxOutputTokens: 222,
      capabilities: ["stale-cap"],
      isHidden: true,
      baseModelName: "stale-base",
    },
  });

  await prisma.llmPricingTier.create({
    data: {
      modelId: model.id,
      name: "Standard",
      isDefault: true,
      priority: 0,
      conditions: [],
      prices: {
        create: [
          { modelId: model.id, usageType: "input", price: STALE_INPUT_PRICE },
          { modelId: model.id, usageType: "output", price: STALE_OUTPUT_PRICE },
        ],
      },
    },
  });

  return model;
}

async function createGeminiProWithStaleBaseModelName(prisma: PrismaClient) {
  const catalogEntry = modelCatalog[geminiProDef.modelName];
  expect(catalogEntry).toBeDefined();
  expect(catalogEntry.baseModelName).toBeNull();

  const model = await prisma.llmModel.create({
    data: {
      friendlyId: generateFriendlyId("llm_model"),
      projectId: null,
      modelName: geminiProDef.modelName,
      matchPattern: "^stale-gemini-pattern$",
      startDate: geminiProDef.startDate ? new Date(geminiProDef.startDate) : null,
      source: "default",
      provider: "stale-provider",
      description: "stale description",
      contextWindow: 111,
      maxOutputTokens: 222,
      capabilities: ["stale-cap"],
      isHidden: true,
      baseModelName: STALE_BASE_MODEL_NAME,
    },
  });

  const tier = geminiProDef.pricingTiers[0];
  await prisma.llmPricingTier.create({
    data: {
      modelId: model.id,
      name: tier.name,
      isDefault: tier.isDefault,
      priority: tier.priority,
      conditions: tier.conditions,
      prices: {
        create: Object.entries(tier.prices).map(([usageType, price]) => ({
          modelId: model.id,
          usageType,
          price,
        })),
      },
    },
  });

  return model;
}

async function loadGpt4oWithTiers(prisma: PrismaClient) {
  return prisma.llmModel.findFirst({
    where: { projectId: null, modelName: gpt4oDef.modelName },
    include: {
      pricingTiers: {
        include: { prices: true },
        orderBy: { priority: "asc" },
      },
    },
  });
}

function expectBundledGpt4oPricing(model: NonNullable<Awaited<ReturnType<typeof loadGpt4oWithTiers>>>) {
  expect(model.matchPattern).toBe(gpt4oDef.matchPattern);
  expect(model.pricingTiers).toHaveLength(gpt4oDef.pricingTiers.length);

  const dbTier = model.pricingTiers[0];
  const defTier = gpt4oDef.pricingTiers[0];
  expect(dbTier.name).toBe(defTier.name);
  expect(dbTier.isDefault).toBe(defTier.isDefault);
  expect(dbTier.priority).toBe(defTier.priority);

  const priceByType = new Map(dbTier.prices.map((p) => [p.usageType, Number(p.price)]));
  for (const [usageType, expected] of Object.entries(defTier.prices)) {
    expect(priceByType.get(usageType)).toBeCloseTo(expected, 12);
  }
  expect(priceByType.size).toBe(Object.keys(defTier.prices).length);
}

describe("syncLlmCatalog", () => {
  postgresTest(
    "rebuilds gpt-4o pricing tiers from bundled defaults when source is default",
    async ({ prisma }) => {
      await createGpt4oWithStalePricing(prisma, "default");

      const result = await syncLlmCatalog(prisma);

      expect(result.modelsUpdated).toBe(1);
      expect(result.modelsSkipped).toBe(defaultModelPrices.length - 1);

      const after = await loadGpt4oWithTiers(prisma);
      expect(after).not.toBeNull();
      expectBundledGpt4oPricing(after!);
    }
  );

  postgresTest(
    "does not replace pricing tiers when model source is not default",
    async ({ prisma }) => {
      await createGpt4oWithStalePricing(prisma, "admin");

      const result = await syncLlmCatalog(prisma);

      expect(result.modelsUpdated).toBe(0);
      expect(result.modelsSkipped).toBeGreaterThanOrEqual(1);

      const after = await loadGpt4oWithTiers(prisma);
      expect(after).not.toBeNull();
      expect(after!.matchPattern).toBe("^stale-pattern$");
      expect(after!.pricingTiers).toHaveLength(1);
      const prices = after!.pricingTiers[0].prices;
      const input = prices.find((p) => p.usageType === "input");
      const output = prices.find((p) => p.usageType === "output");
      expect(Number(input?.price)).toBeCloseTo(STALE_INPUT_PRICE, 12);
      expect(Number(output?.price)).toBeCloseTo(STALE_OUTPUT_PRICE, 12);
      expect(prices).toHaveLength(2);
    }
  );

  postgresTest(
    "clears baseModelName when bundled catalog has null (regression for nullish-coalescing merge)",
    async ({ prisma }) => {
      await createGeminiProWithStaleBaseModelName(prisma);

      await syncLlmCatalog(prisma);

      const after = await prisma.llmModel.findFirst({
        where: { projectId: null, modelName: geminiProDef.modelName },
      });
      expect(after).not.toBeNull();
      expect(after!.baseModelName).toBeNull();
    }
  );
});
