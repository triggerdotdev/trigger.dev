import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

async function requireAdmin(request: Request) {
  const authResult = await authenticateApiRequestWithPersonalAccessToken(request);
  if (!authResult) {
    throw json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: authResult.userId } });
  if (!user?.admin) {
    throw json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  return user;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireAdmin(request);

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

const UpdateModelSchema = z.object({
  modelName: z.string().min(1).optional(),
  matchPattern: z.string().min(1).optional(),
  startDate: z.string().nullable().optional(),
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
  await requireAdmin(request);

  const modelId = params.modelId!;

  if (request.method === "DELETE") {
    const existing = await prisma.llmModel.findUnique({ where: { id: modelId } });
    if (!existing) {
      return json({ error: "Model not found" }, { status: 404 });
    }

    await prisma.llmModel.delete({ where: { id: modelId } });
    return json({ success: true });
  }

  if (request.method !== "PUT") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();
  const parsed = UpdateModelSchema.safeParse(body);

  if (!parsed.success) {
    return json({ error: "Invalid request body", details: parsed.error.issues }, { status: 400 });
  }

  const { modelName, matchPattern, startDate, pricingTiers } = parsed.data;

  // Validate regex if provided
  if (matchPattern) {
    try {
      new RegExp(matchPattern);
    } catch {
      return json({ error: "Invalid regex in matchPattern" }, { status: 400 });
    }
  }

  // Update model fields
  const model = await prisma.llmModel.update({
    where: { id: modelId },
    data: {
      ...(modelName !== undefined && { modelName }),
      ...(matchPattern !== undefined && { matchPattern }),
      ...(startDate !== undefined && { startDate: startDate ? new Date(startDate) : null }),
    },
  });

  // If pricing tiers provided, replace them entirely
  if (pricingTiers) {
    // Delete existing tiers (cascades to prices)
    await prisma.llmPricingTier.deleteMany({ where: { modelId } });

    // Create new tiers
    for (const tier of pricingTiers) {
      await prisma.llmPricingTier.create({
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

  const updated = await prisma.llmModel.findUnique({
    where: { id: modelId },
    include: {
      pricingTiers: {
        include: { prices: true },
        orderBy: { priority: "asc" },
      },
    },
  });

  return json({ model: updated });
}
