import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { logger } from "~/services/logger.server";
import { ssoController } from "~/services/sso.server";
import { accountsWebhookWorker } from "~/v3/accountsWebhookWorker.server";

// Thin, vendor-neutral passthrough for inbound account-management
// webhooks. This route does NOT verify or interpret the payload — it
// forwards the raw body + headers to the plugin, which owns the
// provider-specific signature scheme, then enqueues the verified event
// for the background worker. When no plugin is installed the controller
// returns `feature_disabled` and we 404 (don't advertise the endpoint).
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers);

  const verified = await ssoController.verifyWebhook({ rawBody, headers });

  if (verified.isErr()) {
    switch (verified.error) {
      case "invalid_signature":
        return json({ error: "invalid signature" }, { status: 400 });
      case "feature_disabled":
        return json({ error: "not found" }, { status: 404 });
      default:
        // Transient/internal — let the provider retry.
        logger.error("accounts webhook verify failed", { reason: verified.error });
        return json({ error: "internal error" }, { status: 500 });
    }
  }

  // Idempotent enqueue keyed on the event id — providers redeliver, so
  // dedupe at the door. Processing happens async in accountsWebhookWorker.
  await accountsWebhookWorker.enqueueOnce({
    id: verified.value.event.id,
    job: "account.webhook.event",
    payload: verified.value.event,
  });

  return json({ received: true }, { status: 200 });
}
