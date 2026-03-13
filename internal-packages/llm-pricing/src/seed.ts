import type { PrismaClient } from "@trigger.dev/database";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
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

    // Create model + tiers atomically so partial models can't be left behind
    await prisma.$transaction(async (tx) => {
      const model = await tx.llmModel.create({
        data: {
          friendlyId: generateFriendlyId("llm_model"),
          modelName: modelDef.modelName.trim(),
          matchPattern: modelDef.matchPattern,
          startDate: modelDef.startDate ? new Date(modelDef.startDate) : null,
          source: "default",
        },
      });

      for (const tier of modelDef.pricingTiers) {
        await tx.llmPricingTier.create({
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
    });

    modelsCreated++;
  }

  return { modelsCreated, modelsSkipped };
}
