import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "~/env.server";
import {
  IncidentWebhookSchema,
  isCustomerNotifiableEvent,
  normalizeIncidentUpdate,
} from "~/services/betterstack/incidentWebhook";
import { logger } from "~/services/logger.server";
import { alertsWorker } from "~/v3/alertsWorker.server";

// Inbound status-page webhook. BetterStack can't send custom headers, so we
// auth via a `?token=` shared secret (redacted from logs at ingress). 404 when
// disabled or unconfigured. We 200 fast and hand off to the worker; the enqueue
// is deduped on the update id since BetterStack redelivers on failure.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const secret = env.BETTERSTACK_INCIDENT_WEBHOOK_SECRET;
  if (env.INCIDENT_NOTIFY_ENABLED !== "1" || !secret) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!secretsMatch(token, secret)) {
    return json({ error: "Invalid token" }, { status: 401 });
  }

  const rawBody = await request.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = IncidentWebhookSchema.safeParse(parsed);
  if (!payload.success) {
    logger.warn("BetterStack incident webhook: invalid payload", {
      issues: payload.error.issues,
    });
    return json({ error: "Invalid payload", issues: payload.error.issues }, { status: 400 });
  }

  // Maintenance and component-update events are not customer incidents.
  if (!isCustomerNotifiableEvent(payload.data)) {
    return json({ ignored: true, reason: "non_incident_event" }, { status: 200 });
  }

  const update = normalizeIncidentUpdate(payload.data);
  if (!update) {
    return json({ ignored: true, reason: "no_updates" }, { status: 200 });
  }

  await alertsWorker.enqueueOnce({
    id: `incident-notify:${update.updateId}`,
    job: "v3.fanoutIncidentNotification",
    payload: update,
  });

  return json({ received: true }, { status: 200 });
}

// Hash both sides so timingSafeEqual gets equal-length buffers without leaking length.
function secretsMatch(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  return timingSafeEqual(aHash, bHash);
}
