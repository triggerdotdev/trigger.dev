import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { publishLlmRegistryReload } from "~/v3/llmPricingRegistry.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") ?? "1");
  const pageSize = parseInt(url.searchParams.get("pageSize") ?? "50");

  const [models, total] = await Promise.all([
    prisma.llmModel.findMany({
      where: { projectId: null },
      include: {
        pricingTiers: {
          include: { prices: true },
          orderBy: { priority: "asc" },
        },
      },
      orderBy: { modelName: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.llmModel.count({ where: { projectId: null } }),
  ]);

  return json({ models, total, page, pageSize });
}

// Widened to accept the new upstream sources produced by the billing-app
// trigger.dev tasks. "langfuse" for Langfuse-synced rows, "auto" for rows
// auto-priced from provider-reported span cost, "research" for rows upserted
// by the Claude-driven research task, "provider-api" for rows polled from a
// provider's /v1/models endpoint. Keep in sync with the `source` column in
// prisma/schema.prisma.
const ModelSourceSchema = z.enum([
  "default",
  "admin",
  "langfuse",
  "auto",
  "research",
  "provider-api",
]);

const CreateModelSchema = z.object({
  modelName: z.string().min(1),
  matchPattern: z.string().min(1),
  startDate: z.string().optional(),
  source: ModelSourceSchema.optional().default("admin"),
  provider: z.string().optional(),
  description: z.string().optional(),
  contextWindow: z.number().int().optional(),
  maxOutputTokens: z.number().int().optional(),
  capabilities: z.array(z.string()).optional(),
  isHidden: z.boolean().optional(),
  needsReview: z.boolean().optional(),
  resolvedAt: z.string().datetime().optional(),
  releaseDate: z.string().datetime().optional(),
  deprecationDate: z.string().datetime().optional(),
  knowledgeCutoff: z.string().datetime().optional(),
  supportsStructuredOutput: z.boolean().optional(),
  supportsParallelToolCalls: z.boolean().optional(),
  supportsStreamingToolCalls: z.boolean().optional(),
  pricingTiers: z.array(
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
  ),
});

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateModelSchema.safeParse(body);

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

  // Validate regex pattern — strip (?i) POSIX flag since our registry handles it
  try {
    const testPattern = matchPattern.startsWith("(?i)") ? matchPattern.slice(4) : matchPattern;
    new RegExp(testPattern);
  } catch {
    return json({ error: "Invalid regex in matchPattern" }, { status: 400 });
  }

  // Create model + tiers atomically
  const created = await prisma.$transaction(async (tx) => {
    const model = await tx.llmModel.create({
      data: {
        friendlyId: generateFriendlyId("llm_model"),
        modelName,
        matchPattern,
        startDate: startDate ? new Date(startDate) : null,
        source,
        provider: provider ?? null,
        description: description ?? null,
        contextWindow: contextWindow ?? null,
        maxOutputTokens: maxOutputTokens ?? null,
        capabilities: capabilities ?? [],
        isHidden: isHidden ?? false,
        needsReview: needsReview ?? false,
        resolvedAt: resolvedAt ? new Date(resolvedAt) : null,
        releaseDate: releaseDate ? new Date(releaseDate) : null,
        deprecationDate: deprecationDate ? new Date(deprecationDate) : null,
        knowledgeCutoff: knowledgeCutoff ? new Date(knowledgeCutoff) : null,
        supportsStructuredOutput: supportsStructuredOutput ?? null,
        supportsParallelToolCalls: supportsParallelToolCalls ?? null,
        supportsStreamingToolCalls: supportsStreamingToolCalls ?? null,
      },
    });

    for (const tier of pricingTiers) {
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

    return tx.llmModel.findUnique({
      where: { id: model.id },
      include: {
        pricingTiers: { include: { prices: true } },
      },
    });
  });

  // Notify all webapp replicas to reload the in-memory pricing registry. Rows
  // with needsReview=true are excluded from the registry anyway, so we could
  // skip the publish for those, but a reload is cheap and keeps the code path
  // uniform.
  await publishLlmRegistryReload(`admin-create:${source}`);

  return json({ model: created }, { status: 201 });
}
