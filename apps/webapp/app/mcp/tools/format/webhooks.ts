import type {
  WebhookDeliveryListItem,
  WebhookDeliveryObject,
  WebhookDeliveryTargetObject,
} from "@trigger.dev/core/v3";
import { fenceUntrusted } from "../../gate/fence.server";

const EVENT_CHARS = 4_000;

export function formatDeliveryList(
  deliveries: WebhookDeliveryListItem[],
  nextCursor: string | undefined
): string {
  if (deliveries.length === 0) {
    return nextCursor
      ? `No deliveries on this page. Call again with cursor "${nextCursor}" for older deliveries.`
      : "No deliveries match.";
  }

  const lines = ["## Webhook deliveries\n"];
  for (const d of deliveries) {
    const endpoint = d.endpoint ? ` · ${d.endpoint.declaredId}` : "";
    const test = d.isTest ? " · test" : "";
    lines.push(
      `- ${d.id} · ${d.status}${endpoint} · ${fenceUntrusted(d.externalDeliveryId, "webhook-delivery-id")} · ${d.createdAt.toISOString()}${test}`
    );
  }
  if (nextCursor) lines.push(`\nMore deliveries: call again with cursor "${nextCursor}".`);
  return lines.join("\n");
}

export function formatDelivery(d: WebhookDeliveryObject): string {
  const lines = [`## Delivery ${d.id}\n`];
  lines.push(`Status: ${d.status}${d.isTest ? " (test)" : ""}`);
  if (d.endpoint) lines.push(`Endpoint: ${d.endpoint.declaredId} (${d.endpoint.id})`);
  lines.push(
    `External delivery id: ${fenceUntrusted(d.externalDeliveryId, "webhook-delivery-id")}`
  );
  lines.push(`Received: ${d.createdAt.toISOString()}`);
  if (d.processedAt) lines.push(`Processed: ${d.processedAt.toISOString()}`);
  if (d.error) lines.push(`Error: ${fenceUntrusted(d.error, "webhook-delivery-error")}`);
  if (d.filterReason)
    lines.push(`Filtered: ${fenceUntrusted(d.filterReason, "webhook-filter-reason")}`);

  lines.push("\n### Targets");
  if (d.targets.length === 0) {
    lines.push("No subscribers or waiters to route to.");
  } else {
    for (const target of d.targets) lines.push(`- ${formatTarget(target)}`);
  }

  lines.push("\n### Event");
  if (d.event == null) {
    lines.push("Not captured.");
  } else {
    const json = JSON.stringify(d.event, null, 2);
    const body = json.length > EVENT_CHARS ? `${json.slice(0, EVENT_CHARS)}\n… (truncated)` : json;
    lines.push(fenceUntrusted(body, "webhook-event"));
  }

  const headers = Object.entries(d.headers ?? {});
  if (headers.length > 0) {
    lines.push("\n### Headers");
    const sorted = headers.sort(([a], [b]) => a.localeCompare(b));
    const text = sorted.map(([name, value]) => `- ${name}: ${value}`).join("\n");
    lines.push(fenceUntrusted(text, "webhook-headers"));
  }

  return lines.join("\n");
}

function formatTarget(t: WebhookDeliveryTargetObject): string {
  if (t.type === "waiter") {
    const w = t.waiters;
    const counts = w ? `${w.resumed} of ${w.matched} waiting runs resumed, ${w.failed} failed` : "";
    return `waiting runs · ${t.status}${counts ? ` · ${counts}` : ""}${t.error ? ` · ${fenceUntrusted(t.error, "webhook-target")}` : ""}`;
  }
  const parts = [`${t.id} (${t.type})`, t.status];
  if (t.runId) parts.push(`run ${t.runId}`);
  if (t.sessionId) parts.push(`session ${t.sessionId}`);
  if (t.reason) parts.push(fenceUntrusted(t.reason, "webhook-target"));
  if (t.error) parts.push(fenceUntrusted(t.error, "webhook-target"));
  return parts.join(" · ");
}

export function fenceSetupPrompt(
  prompt: string,
  endpoint: { tenantId: string | null; subscribers: { filter?: string | null }[] }
): string {
  let fenced = prompt;
  if (endpoint.tenantId) {
    fenced = fenced
      .split(`(tenant ${endpoint.tenantId})`)
      .join(`(tenant ${fenceUntrusted(endpoint.tenantId, "webhook-endpoint")})`);
  }
  for (const { filter } of endpoint.subscribers) {
    if (!filter) continue;
    fenced = fenced
      .split(`\`${filter}\``)
      .join(fenceUntrusted(filter, "webhook-subscriber-filter"));
  }
  return fenced;
}
