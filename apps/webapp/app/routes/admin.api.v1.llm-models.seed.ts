import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { seedLlmPricing, syncLlmCatalog } from "@internal/llm-model-catalog";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "seed";

  if (action === "sync") {
    const result = await syncLlmCatalog(prisma);

    if (llmPricingRegistry) {
      await llmPricingRegistry.reload();
    }

    return json({
      success: true,
      ...result,
      message: `Synced ${result.modelsUpdated} models, skipped ${result.modelsSkipped}`,
    });
  }

  // Default: seed (creates new + syncs existing)
  const result = await seedLlmPricing(prisma);

  if (llmPricingRegistry) {
    await llmPricingRegistry.reload();
  }

  return json({
    success: true,
    ...result,
    message: `Seeded ${result.modelsCreated} created, ${result.modelsSkipped} skipped, ${result.modelsUpdated} updated`,
  });
}
