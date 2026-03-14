import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { seedLlmPricing } from "@internal/llm-pricing";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

export async function action({ request }: ActionFunctionArgs) {
  const authResult = await authenticateApiRequestWithPersonalAccessToken(request);
  if (!authResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: authResult.userId } });
  if (!user?.admin) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  const result = await seedLlmPricing(prisma);

  // Reload the in-memory registry after seeding (if enabled)
  if (llmPricingRegistry) {
    await llmPricingRegistry.reload();
  }

  return json({
    success: true,
    ...result,
    message: `Seeded ${result.modelsCreated} models, skipped ${result.modelsSkipped} existing`,
  });
}
