import { alertsWorker } from "~/v3/alertsWorker.server";

export async function enqueueAlertEventDelivery({
  eventId,
  eventAt,
}: {
  eventId: string;
  eventAt: Date;
}): Promise<void> {
  await alertsWorker.enqueue({
    id: `alert-event:${eventId}`,
    job: "v3.deliverAlertEvent",
    payload: { eventId, eventAt },
  });
}
