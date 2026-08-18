import { env } from "~/env.server";

// Public origin webhook providers POST to. A dedicated WEBHOOK_INGRESS_ORIGIN (e.g.
// https://webhook.trigger.dev) takes precedence; otherwise it rides the API/app origin.
function webhookIngressOrigin(): string {
  return env.WEBHOOK_INGRESS_ORIGIN ?? env.API_ORIGIN ?? env.APP_ORIGIN;
}

export function webhookIngressUrl(opaqueId: string): string {
  return `${webhookIngressOrigin()}/webhooks/v1/ingest/${opaqueId}`;
}
