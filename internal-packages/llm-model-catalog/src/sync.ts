import type { PrismaClient } from "@trigger.dev/database";
import { defaultModelPrices } from "./defaultPrices.js";
import { modelCatalog } from "./modelCatalog.js";

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

    await prisma.llmModel.update({
      where: { id: existing.id },
      data: {
        // Update match pattern and start date from Langfuse (may have changed)
        matchPattern: modelDef.matchPattern,
        startDate: modelDef.startDate ? new Date(modelDef.startDate) : null,
        // Update catalog metadata
        provider: catalog?.provider ?? existing.provider,
        description: catalog?.description ?? existing.description,
        contextWindow: catalog?.contextWindow ?? existing.contextWindow,
        maxOutputTokens: catalog?.maxOutputTokens ?? existing.maxOutputTokens,
        capabilities: catalog?.capabilities ?? existing.capabilities,
        isHidden: catalog?.isHidden ?? existing.isHidden,
        baseModelName: catalog?.baseModelName ?? existing.baseModelName,
      },
    });

    modelsUpdated++;
  }

  return { modelsUpdated, modelsSkipped };
}
