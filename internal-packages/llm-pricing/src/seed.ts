import type { PrismaClient } from "@trigger.dev/database";
import { defaultModelPrices } from "./defaultPrices.js";

export async function seedLlmPricing(prisma: PrismaClient): Promise<{
  modelsCreated: number;
  modelsSkipped: number;
}> {
  let modelsCreated = 0;
  let modelsSkipped = 0;

  for (const modelDef of defaultModelPrices) {
    // Check if this model already exists (don't overwrite admin changes)
    const existing = await prisma.llmModel.findFirst({
      where: {
        projectId: null,
        modelName: modelDef.modelName,
      },
    });

    if (existing) {
      modelsSkipped++;
      continue;
    }

    // Create model first
    const model = await prisma.llmModel.create({
      data: {
        modelName: modelDef.modelName,
        matchPattern: modelDef.matchPattern,
        startDate: modelDef.startDate ? new Date(modelDef.startDate) : null,
        source: "default",
      },
    });

    // Create tiers and prices with explicit model connection
    for (const tier of modelDef.pricingTiers) {
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
    }

    modelsCreated++;
  }

  return { modelsCreated, modelsSkipped };
}
