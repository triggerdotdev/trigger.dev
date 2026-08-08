import { type WebhookDeliveryStatus } from "@trigger.dev/database";
import {
  type TimelineEventState,
  type TimelineEventVariant,
  type TimelineLineVariant,
} from "~/components/run/RunTimeline";

export type DeliveryRunTarget = {
  run: { friendlyId: string } | null;
  session: { friendlyId: string; externalId: string | null } | null;
};

export type DeliveryTimelineEventItem = {
  type: "event";
  id: string;
  title: string;
  date: Date | null;
  previousDate?: Date;
  state: TimelineEventState;
  variant: TimelineEventVariant;
  note?: string | null;
  target?: DeliveryRunTarget;
};

export type DeliveryTimelineLineItem = {
  type: "line";
  id: string;
  from: Date;
  to: Date | null;
  state: TimelineEventState;
  variant: TimelineLineVariant;
  label?: string;
};

export type DeliveryTimelineItem = DeliveryTimelineEventItem | DeliveryTimelineLineItem;

export type BuildDeliveryTimelineInput = {
  status: WebhookDeliveryStatus;
  createdAt: Date;
  processedAt: Date | null;
  errorMessage: string | null;
  filterReason: string | null;
  run: { friendlyId: string } | null;
  session: { friendlyId: string; externalId: string | null } | null;
};

export function buildDeliveryTimelineItems(
  delivery: BuildDeliveryTimelineInput
): DeliveryTimelineItem[] {
  const { status, createdAt, processedAt } = delivery;
  const inFlight = status === "PENDING" || status === "PROCESSING";

  const items: DeliveryTimelineItem[] = [
    {
      type: "event",
      id: "received",
      title: "Received",
      date: createdAt,
      state: "complete",
      variant: "start-cap",
    },
  ];

  if (status === "FILTERED") {
    items.push({
      type: "line",
      id: "routing",
      from: createdAt,
      to: processedAt ?? createdAt,
      state: "delayed",
      variant: "light",
    });
    items.push({
      type: "event",
      id: "filtered",
      title: "Filtered",
      date: processedAt ?? createdAt,
      previousDate: createdAt,
      state: "delayed",
      variant: "dot-solid",
      note: delivery.filterReason,
    });
    return items;
  }

  items.push({
    type: "line",
    id: "routing",
    from: createdAt,
    to: inFlight ? null : processedAt,
    state: inFlight ? "inprogress" : status === "FAILED" ? "error" : "complete",
    variant: "normal",
    label: "Routing",
  });

  if (inFlight) {
    return items;
  }

  if (status === "SUCCEEDED") {
    items.push({
      type: "event",
      id: "delivered",
      title: "Delivered",
      date: processedAt,
      previousDate: createdAt,
      state: "complete",
      variant: "end-cap-thick",
      target: { run: delivery.run, session: delivery.session },
    });
  } else if (status === "FAILED") {
    items.push({
      type: "event",
      id: "failed",
      title: "Failed",
      date: processedAt,
      previousDate: createdAt,
      state: "error",
      variant: "end-cap-thick",
      note: delivery.errorMessage,
    });
  }

  return items;
}
