import { withAdminApi } from "~/services/adminApi.server";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

async function handleAction({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (!llmPricingRegistry) {
    return json({ error: "LLM cost tracking is disabled" }, { status: 400 });
  }

  await llmPricingRegistry.reload();

  return json({ success: true, message: "LLM pricing registry reloaded" });
}

export const action = withAdminApi(handleAction);
