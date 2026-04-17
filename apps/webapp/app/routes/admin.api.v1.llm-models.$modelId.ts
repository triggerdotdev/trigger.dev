import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { publishLlmRegistryReload } from "~/v3/llmPricingRegistry.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);

  const model = await prisma.llmModel.findUnique({
    where: { id: params.modelId },
    include: {
      pricingTiers: {
        include: { prices: true },
        orderBy: { priority: "asc" },
      },
    },
  });

  if (!model) {
    return json({ error: "Model not found" }, { status: 404 });
  }

  return json({ model });
}

// Keep in sync with admin.api.v1.llm-models.ts.
const ModelSourceSchema = z.enum([
  "default",
  "admin",
  "langfuse",
  "auto",
  "research",
  "provider-api",
]);

const UpdateModelSchema = z.object({
  modelName: z.string().min(1).optional(),
  matchPattern: z.string().min(1).optional(),
  startDate: z.string().nullable().optional(),
  source: ModelSourceSchema.optional(),
  provider: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  contextWindow: z.number().int().nullable().optional(),
  maxOutputTokens: z.number().int().nullable().optional(),
  capabilities: z.array(z.string()).optional(),
  isHidden: z.boolean().optional(),
  needsReview: z.boolean().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
  releaseDate: z.string().datetime().nullable().optional(),
  deprecationDate: z.string().datetime().nullable().optional(),
  knowledgeCutoff: z.string().datetime().nullable().optional(),
  supportsStructuredOutput: z.boolean().nullable().optional(),
  supportsParallelToolCalls: z.boolean().nullable().optional(),
  supportsStreamingToolCalls: z.boolean().nullable().optional(),
  pricingTiers: z
    .array(
      z.object({
        name: z.string().min(1),
        isDefault: z.boolean().default(true),
        priority: z.number().int().default(0),
        conditions: z
          .array(
            z.object({
              usageDetailPattern: z.string(),
              operator: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]),
              value: z.number(),
            })
          )
          .default([]),
        prices: z.record(z.string(), z.number()),
      })
    )
    .optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const modelId = params.modelId!;

  if (request.method === "DELETE") {
    const existing = await prisma.llmModel.findUnique({ where: { id: modelId } });
    if (!existing) {
      return json({ error: "Model not found" }, { status: 404 });
    }

    await prisma.llmModel.delete({ where: { id: modelId } });
    await publishLlmRegistryReload(`admin-delete:${existing.source}`);
    return json({ success: true });
  }

  if (request.method !== "PUT") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = UpdateModelSchema.safeParse(body);

  if (!parsed.success) {
    return json({ error: "Invalid request body", details: parsed.error.issues }, { status: 400 });
  }

  const {
    modelName,
    matchPattern,
    startDate,
    source,
    pricingTiers,
    provider,
    description,
    contextWindow,
    maxOutputTokens,
    capabilities,
    isHidden,
    needsReview,
    resolvedAt,
    releaseDate,
    deprecationDate,
    knowledgeCutoff,
    supportsStructuredOutput,
    supportsParallelToolCalls,
    supportsStreamingToolCalls,
  } = parsed.data;

  // Validate regex if provided — strip (?i) POSIX flag since our registry handles it
  if (matchPattern) {
    try {
      const testPattern = matchPattern.startsWith("(?i)") ? matchPattern.slice(4) : matchPattern;
      new RegExp(testPattern);
    } catch {
      return json({ error: "Invalid regex in matchPattern" }, { status: 400 });
    }
  }

  // Update model + tiers atomically
  const updated = await prisma.$transaction(async (tx) => {
    await tx.llmModel.update({
      where: { id: modelId },
      data: {
        ...(modelName !== undefined && { modelName }),
        ...(matchPattern !== undefined && { matchPattern }),
        ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
        ...(source !== undefined && { source }),
        ...(provider !== undefined && { provider }),
        ...(description !== undefined && { description }),
        ...(contextWindow !== undefined && { contextWindow }),
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
        ...(capabilities !== undefined && { capabilities }),
        ...(isHidden !== undefined && { isHidden }),
        ...(needsReview !== undefined && { needsReview }),
        ...(resolvedAt !== undefined && {
          resolvedAt: resolvedAt ? new Date(resolvedAt) : null,
        }),
        ...(releaseDate !== undefined && {
          releaseDate: releaseDate ? new Date(releaseDate) : null,
        }),
        ...(deprecationDate !== undefined && {
          deprecationDate: deprecationDate ? new Date(deprecationDate) : null,
        }),
        ...(knowledgeCutoff !== undefined && {
          knowledgeCutoff: knowledgeCutoff ? new Date(knowledgeCutoff) : null,
        }),
        ...(supportsStructuredOutput !== undefined && { supportsStructuredOutput }),
        ...(supportsParallelToolCalls !== undefined && { supportsParallelToolCalls }),
        ...(supportsStreamingToolCalls !== undefined && { supportsStreamingToolCalls }),
      },
    });

    if (pricingTiers) {
      await tx.llmPricingTier.deleteMany({ where: { modelId } });

      for (const tier of pricingTiers) {
        await tx.llmPricingTier.create({
          data: {
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
          },
        });
      }
    }

    return tx.llmModel.findUnique({
      where: { id: modelId },
      include: {
        pricingTiers: { include: { prices: true }, orderBy: { priority: "asc" } },
      },
    });
  });

  await publishLlmRegistryReload(`admin-update:${updated?.source ?? "unknown"}`);

  return json({ model: updated });
}
