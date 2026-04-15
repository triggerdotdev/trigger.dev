import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (!llmPricingRegistry) {
    return json({ error: "LLM cost tracking is disabled" }, { status: 400 });
  }

  await llmPricingRegistry.reload();

  return json({ success: true, message: "LLM pricing registry reloaded" });
}
