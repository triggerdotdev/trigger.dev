import type { PrismaClient } from "@trigger.dev/database";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { defaultModelPrices } from "./defaultPrices.js";
import { modelCatalog } from "./modelCatalog.js";
import { syncLlmCatalog } from "./sync.js";

export async function seedLlmPricing(prisma: PrismaClient): Promise<{
  modelsCreated: number;
  modelsSkipped: number;
  modelsUpdated: number;
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

    // Look up catalog metadata for this model
    const catalog = modelCatalog[modelDef.modelName];

    // Create model + tiers atomically so partial models can't be left behind
    await prisma.$transaction(async (tx) => {
      const model = await tx.llmModel.create({
        data: {
          friendlyId: generateFriendlyId("llm_model"),
          modelName: modelDef.modelName.trim(),
          matchPattern: modelDef.matchPattern,
          startDate: modelDef.startDate ? new Date(modelDef.startDate) : null,
          source: "default",
          // Catalog metadata (from model-catalog.json)
          provider: catalog?.provider ?? null,
          description: catalog?.description ?? null,
          contextWindow: catalog?.contextWindow ?? null,
          maxOutputTokens: catalog?.maxOutputTokens ?? null,
          capabilities: catalog?.capabilities ?? [],
          isHidden: catalog?.isHidden ?? false,
          baseModelName: catalog?.baseModelName ?? null,
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

  // Sync catalog metadata on existing default models
  const syncResult = await syncLlmCatalog(prisma);

  return { modelsCreated, modelsSkipped, modelsUpdated: syncResult.modelsUpdated };
}
