import { type NormalizedIncidentUpdate } from "~/services/betterstack/incidentWebhook";
import { alertsWorker } from "~/v3/alertsWorker.server";

/**
 * Fan an update out into one job per surface, deduped on update id + surface so
 * retries never double-notify. Unconfigured surfaces no-op in their handler.
 */
export async function fanoutIncidentNotification(update: NormalizedIncidentUpdate): Promise<void> {
  await Promise.all([
    alertsWorker.enqueueOnce({
      id: `incident-notify:${update.updateId}:slack`,
      job: "v3.deliverIncidentSlack",
      payload: { update },
    }),
    alertsWorker.enqueueOnce({
      id: `incident-notify:${update.updateId}:discord`,
      job: "v3.deliverIncidentDiscord",
      payload: { update },
    }),
    alertsWorker.enqueueOnce({
      id: `incident-notify:${update.updateId}:email:start`,
      job: "v3.deliverIncidentEmail",
      payload: { update, cursor: null },
    }),
  ]);
}
