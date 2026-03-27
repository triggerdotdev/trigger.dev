import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { defaultModelPrices } from "./defaultPrices.js";
import { modelCatalog } from "./modelCatalog.js";
import type { DefaultModelDefinition } from "./types.js";

function pricingTierCreateData(
  modelId: string,
  tier: DefaultModelDefinition["pricingTiers"][number]
): Prisma.LlmPricingTierUncheckedCreateInput {
  return {
    modelId,
    name: tier.name,
    isDefault: tier.isDefault,
    priority: tier.priority,
    conditions: tier.conditions,
    prices: {
      create: Object.entries(tier.prices).map(([usageType, price]) => ({
        modelId,
        usageType,
        price,
      })),
    },
  };
}

export async function syncLlmCatalog(prisma: PrismaClient): Promise<{
  modelsUpdated: number;
  modelsSkipped: number;
}> {
  let modelsUpdated = 0;
  let modelsSkipped = 0;

  for (const modelDef of defaultModelPrices) {
    const existing = await prisma.llmModel.findFirst({
      where: {
        projectId: null,
        modelName: modelDef.modelName,
      },
    });

    // Skip if model doesn't exist yet (seed handles creation)
    if (!existing) {
      modelsSkipped++;
      continue;
    }

    // Don't overwrite admin-edited models
    if (existing.source !== "default") {
      modelsSkipped++;
      continue;
    }

    const catalog = modelCatalog[modelDef.modelName];

    await prisma.$transaction(async (tx) => {
      await tx.llmModel.update({
        where: { id: existing.id },
        data: {
          // Update match pattern and start date from Langfuse (may have changed)
          matchPattern: modelDef.matchPattern,
          startDate: modelDef.startDate ? new Date(modelDef.startDate) : null,
          // Update catalog metadata
          provider: catalog?.provider ?? existing.provider,
          description: catalog?.description ?? existing.description,
          contextWindow:
            catalog?.contextWindow === undefined ? existing.contextWindow : catalog.contextWindow,
          maxOutputTokens:
            catalog?.maxOutputTokens === undefined
              ? existing.maxOutputTokens
              : catalog.maxOutputTokens,
          capabilities: catalog?.capabilities ?? existing.capabilities,
          isHidden: catalog?.isHidden ?? existing.isHidden,
          baseModelName: catalog?.baseModelName ?? existing.baseModelName,
        },
      });

      await tx.llmPricingTier.deleteMany({ where: { modelId: existing.id } });

      for (const tier of modelDef.pricingTiers) {
        await tx.llmPricingTier.create({
          data: pricingTierCreateData(existing.id, tier),
        });
      }
    });

    modelsUpdated++;
  }

  return { modelsUpdated, modelsSkipped };
}
