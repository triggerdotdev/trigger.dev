import type { EndpointsListRow } from "~/components/webhookEndpoints/v1/EndpointsListTable";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import type {
  EndpointActivity,
  EndpointActivityBucket,
} from "./WebhookEndpointsListPresenter.server";

type SampleEndpoint = {
  declaredId: string;
  source: string;
  tenantId?: string;
  status?: EndpointsListRow["status"];
  /** Peak deliveries per hour. */
  volume: number;
  failureRate?: number;
  filteredRate?: number;
};

const SAMPLE_ENDPOINTS: SampleEndpoint[] = [
  { declaredId: "stripe", source: "stripe", volume: 180, failureRate: 0.01, filteredRate: 0.35 },
  { declaredId: "github", source: "github", volume: 64, filteredRate: 0.5 },
  { declaredId: "slack", source: "slack", volume: 42 },
  { declaredId: "linear", source: "linear", volume: 26, failureRate: 0.04 },
  { declaredId: "shopify-stores", source: "shopify", tenantId: "northwind", volume: 90 },
  { declaredId: "shopify-stores", source: "shopify", tenantId: "lumen-goods", volume: 55 },
  { declaredId: "clerk", source: "clerk", volume: 14 },
  { declaredId: "resend", source: "resend", volume: 30, status: "DISABLED" },
];

/** Deterministic pseudo-random in [0, 1), so the preview looks the same on every load. */
function noise(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function sampleBuckets(endpoint: SampleEndpoint, index: number, now: Date) {
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);

  const buckets: EndpointActivityBucket[] = [];
  for (let hour = 23; hour >= 0; hour--) {
    const date = new Date(currentHour.getTime() - hour * 60 * 60 * 1000);
    if (endpoint.status === "DISABLED" && hour < 9) {
      buckets.push({ date, total: 0 });
      continue;
    }
    const daily = 0.55 + 0.45 * Math.sin(((date.getUTCHours() - 8) / 24) * Math.PI * 2);
    const total = Math.round(endpoint.volume * daily * (0.6 + 0.4 * noise(index * 97 + hour)));
    const failed = Math.round(total * (endpoint.failureRate ?? 0) * 2 * noise(index * 31 + hour));
    const filtered = Math.round(total * (endpoint.filteredRate ?? 0));
    buckets.push({
      date,
      total,
      SUCCEEDED: total - failed - filtered,
      ...(failed > 0 ? { FAILED: failed } : {}),
      ...(filtered > 0 ? { FILTERED: filtered } : {}),
    });
  }
  return buckets;
}

/** Sample endpoints and activity for the webhooks beta page's blurred product preview. */
export function webhooksBetaPreview(now = new Date()) {
  const endpoints: EndpointsListRow[] = SAMPLE_ENDPOINTS.map((endpoint, index) => {
    const opaqueId = `whk_preview${index.toString().padStart(2, "0")}${Math.floor(
      noise(index + 1) * 1e8
    ).toString(36)}`;
    return {
      id: `preview_${index}`,
      friendlyId: `wep_preview${index}`,
      opaqueId,
      declaredId: endpoint.declaredId,
      tenantId: endpoint.tenantId ?? null,
      externalRef: null,
      source: endpoint.source,
      status: endpoint.status ?? "ACTIVE",
      hasSigningSecret: true,
      ingestUrl: webhookIngressUrl(opaqueId),
    };
  });

  const activity: EndpointActivity = {};
  SAMPLE_ENDPOINTS.forEach((endpoint, index) => {
    const buckets = sampleBuckets(endpoint, index, now);
    const minutesAgo = endpoint.status === "DISABLED" ? 9 * 60 : 1 + Math.floor(noise(index) * 20);
    activity[`preview_${index}`] = {
      buckets,
      lastDeliveryAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
    };
  });

  return { endpoints, activity };
}
