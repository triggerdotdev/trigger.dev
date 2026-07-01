import { z } from "zod";

// Payload for the BetterStack status-page webhook. The endpoint is unsigned, so
// the route auths via a shared secret in the URL.

// BetterStack sends ids as numbers; accept either and normalize to string.
const IdSchema = z.union([z.string(), z.number()]).transform((v) => String(v));

export const IncidentUpdateSchema = z.object({
  id: IdSchema,
  status_report_id: IdSchema.optional(),
  body: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

export const IncidentWebhookSchema = z.object({
  event_type: z.string(),
  page: z
    .object({
      id: IdSchema.optional(),
      status_indicator: z.string().nullish(),
      status_description: z.string().nullish(),
    })
    .optional(),
  // Optional so non-incident callbacks (maintenance/component) parse and are
  // ignored instead of 400ing.
  incident: z
    .object({
      id: IdSchema,
      name: z.string().nullish(),
      created_at: z.string().nullish(),
      updated_at: z.string().nullish(),
      shortlink: z.string().nullish(),
      incident_updates: z.array(IncidentUpdateSchema).default([]),
    })
    .optional(),
});

export type IncidentWebhook = z.infer<typeof IncidentWebhookSchema>;

export const NormalizedIncidentUpdateSchema = z.object({
  incidentId: z.string(),
  updateId: z.string(),
  name: z.string(),
  statusIndicator: z.string(),
  body: z.string(),
  shortlink: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type NormalizedIncidentUpdate = {
  incidentId: string;
  /** The specific update id — our idempotency key. */
  updateId: string;
  name: string;
  /** operational | degraded | downtime | maintenance */
  statusIndicator: string;
  body: string;
  shortlink: string | null;
  updatedAt: string | null;
};

/** Only published "incident" events notify customers, not monitor auto-alerts. */
export function isCustomerNotifiableEvent(payload: IncidentWebhook): boolean {
  return payload.event_type === "incident" && !!payload.incident;
}

/** Reduce the webhook to its most recent update, or null if there are none. */
export function normalizeIncidentUpdate(payload: IncidentWebhook): NormalizedIncidentUpdate | null {
  if (!payload.incident) {
    return null;
  }

  const updates = payload.incident.incident_updates;
  if (updates.length === 0) {
    return null;
  }

  // Sort by created_at so we don't rely on BetterStack's ordering.
  const mostRecent = [...updates].sort((a, b) => {
    const aTime = a.created_at ? Date.parse(a.created_at) : 0;
    const bTime = b.created_at ? Date.parse(b.created_at) : 0;
    return bTime - aTime;
  })[0];

  return {
    incidentId: payload.incident.id,
    updateId: mostRecent.id,
    name: payload.incident.name?.trim() || "Service incident",
    statusIndicator: payload.page?.status_indicator?.trim() || "downtime",
    body: mostRecent.body?.trim() || "",
    shortlink: payload.incident.shortlink?.trim() || null,
    updatedAt: mostRecent.created_at ?? payload.incident.updated_at ?? null,
  };
}
