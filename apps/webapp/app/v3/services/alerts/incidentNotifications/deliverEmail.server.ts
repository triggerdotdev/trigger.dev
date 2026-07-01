import { sendAlertEmail } from "~/services/email.server";
import { type NormalizedIncidentUpdate } from "~/services/betterstack/incidentWebhook";
import { logger } from "~/services/logger.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { incidentUrl, presentStatus } from "./messages";
import { getIncidentEmailRecipientsPage, type IncidentEmailRecipient } from "./recipients.server";

export type DeliverIncidentEmailPayload = {
  update: NormalizedIncidentUpdate;
  cursor: string | null;
};

export type DeliverIncidentEmailToRecipientPayload = {
  update: NormalizedIncidentUpdate;
  recipient: IncidentEmailRecipient;
};

/**
 * Fan one page of admin recipients out into deduped per-recipient send jobs,
 * then enqueue the next page. Does no sending itself, so a retry of this job
 * only re-enqueues (idempotent) rather than re-mailing anyone.
 */
export async function deliverIncidentEmailPage(
  payload: DeliverIncidentEmailPayload
): Promise<void> {
  const { update, cursor } = payload;
  const { recipients, nextCursor } = await getIncidentEmailRecipientsPage(cursor);

  for (const recipient of recipients) {
    await alertsWorker.enqueueOnce({
      id: `incident-notify:${update.updateId}:email:recipient:${recipient.userId}`,
      job: "v3.deliverIncidentEmailRecipient",
      payload: { update, recipient },
    });
  }

  if (nextCursor) {
    await alertsWorker.enqueueOnce({
      id: `incident-notify:${update.updateId}:email:${nextCursor}`,
      job: "v3.deliverIncidentEmail",
      payload: { update, cursor: nextCursor },
    });
  }

  logger.info("Incident email page fanned out", {
    page: recipients.length,
    hasMore: nextCursor !== null,
    updateId: update.updateId,
  });
}

/** Send the incident email to one recipient; throws so the worker retries. */
export async function deliverIncidentEmailToRecipient(
  payload: DeliverIncidentEmailToRecipientPayload
): Promise<void> {
  const { update, recipient } = payload;
  const status = presentStatus(update.statusIndicator);
  await sendAlertEmail({
    email: "incident-notification",
    to: recipient.email,
    name: update.name,
    statusLabel: status.label,
    body: update.body,
    url: incidentUrl(update),
  });
}
