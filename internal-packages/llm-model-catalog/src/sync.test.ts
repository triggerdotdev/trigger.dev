import { describe, it, expect, vi } from "vitest";
import { syncLlmCatalog } from "./sync.js";
import { defaultModelPrices } from "./defaultPrices.js";

const gpt4oDef = defaultModelPrices.find((m) => m.modelName === "gpt-4o");
if (!gpt4oDef) {
  throw new Error("expected gpt-4o in defaultModelPrices");
}

describe("syncLlmCatalog", () => {
  it("rebuilds pricing tiers and prices for existing default-source models", async () => {
    const existingId = "existing-gpt4o";

    const llmModelUpdate = vi.fn();
    const llmPricingTierDeleteMany = vi.fn();
    const llmPricingTierCreate = vi.fn();

    const prisma = {
      llmModel: {
        findFirst: vi.fn(async (args: { where: { modelName: string } }) => {
          if (args.where.modelName === "gpt-4o") {
            return {
              id: existingId,
              source: "default",
              provider: "openai",
              description: "stale description",
              contextWindow: 999,
              maxOutputTokens: 888,
              capabilities: ["legacy"],
              isHidden: true,
              baseModelName: "legacy-base",
            };
          }
          return null;
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
        await fn({
          llmModel: { update: llmModelUpdate },
          llmPricingTier: {
            deleteMany: llmPricingTierDeleteMany,
            create: llmPricingTierCreate,
          },
        });
      }),
    };

    await syncLlmCatalog(prisma as never);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    expect(llmModelUpdate).toHaveBeenCalledWith({
      where: { id: existingId },
      data: expect.objectContaining({
        matchPattern: gpt4oDef.matchPattern,
        startDate: gpt4oDef.startDate ? new Date(gpt4oDef.startDate) : null,
      }),
    });

    expect(llmPricingTierDeleteMany).toHaveBeenCalledWith({
      where: { modelId: existingId },
    });

    expect(llmPricingTierCreate).toHaveBeenCalledTimes(gpt4oDef.pricingTiers.length);

    const firstTier = gpt4oDef.pricingTiers[0];
    expect(llmPricingTierCreate).toHaveBeenCalledWith({
      data: {
        modelId: existingId,
        name: firstTier.name,
        isDefault: firstTier.isDefault,
        priority: firstTier.priority,
        conditions: firstTier.conditions,
        prices: {
          create: expect.arrayContaining(
            Object.entries(firstTier.prices).map(([usageType, price]) => ({
              modelId: existingId,
              usageType,
              price,
            }))
          ),
        },
      },
    });

    const createCall = llmPricingTierCreate.mock.calls[0][0] as {
      data: { prices: { create: { usageType: string; price: number; modelId: string }[] } };
    };
    expect(createCall.data.prices.create).toHaveLength(Object.keys(firstTier.prices).length);
  });

  it("does not rebuild pricing for non-default source models", async () => {
    const prisma = {
      llmModel: {
        findFirst: vi.fn(async (args: { where: { modelName: string } }) => {
          if (args.where.modelName === "gpt-4o") {
            return {
              id: "admin-edited",
              source: "admin",
              provider: null,
              description: null,
              contextWindow: null,
              maxOutputTokens: null,
              capabilities: [],
              isHidden: false,
              baseModelName: null,
            };
          }
          return null;
        }),
      },
      $transaction: vi.fn(),
    };

    const result = await syncLlmCatalog(prisma as never);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.modelsUpdated).toBe(0);
    expect(result.modelsSkipped).toBeGreaterThan(0);
  });
});
