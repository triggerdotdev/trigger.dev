import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import {
  llmPricingRegistry,
  publishLlmRegistryReload,
} from "~/v3/llmPricingRegistry.server";

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (!llmPricingRegistry) {
    return json({ error: "LLM cost tracking is disabled" }, { status: 400 });
  }

  // Reload this replica immediately so the admin UI sees changes instantly …
  await llmPricingRegistry.reload();
  // … and notify the other webapp replicas via pub/sub so their in-memory
  // registries catch up within seconds. This is the endpoint the cloud-repo
  // trigger.dev tasks call after upserting rows.
  const url = new URL(request.url);
  const reason = url.searchParams.get("reason") ?? "admin-reload";
  await publishLlmRegistryReload(reason);

  return json({ success: true, message: "LLM pricing registry reloaded" });
}
