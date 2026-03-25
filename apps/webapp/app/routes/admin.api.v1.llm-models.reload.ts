import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
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

  if (!llmPricingRegistry) {
    return json({ error: "LLM cost tracking is disabled" }, { status: 400 });
  }

  await llmPricingRegistry.reload();

  return json({ success: true, message: "LLM pricing registry reloaded" });
}
