import { type WebhookDeliveryStatus } from "@trigger.dev/database";
import { cn } from "~/utils/cn";

// Reuse the run-status hex palette for the four delivery statuses (matches the
// detail page activity chart and the task-list status bars). No invented colors.
const DELIVERY_STATUS_COLOR: Record<WebhookDeliveryStatus, string> = {
  SUCCEEDED: "#28BF5C",
  FAILED: "#E11D48",
  PROCESSING: "#3B82F6",
  PENDING: "#878C99",
  FILTERED: "#64748B", // received + verified, intentionally not routed; neutral, not a failure
};

const DELIVERY_STATUS_LABEL: Record<WebhookDeliveryStatus, string> = {
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  PROCESSING: "Processing",
  PENDING: "Pending",
  FILTERED: "Filtered",
};

export function DeliveryStatusBadge({
  status,
  className,
}: {
  status: WebhookDeliveryStatus;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1.5", className)}>
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: DELIVERY_STATUS_COLOR[status] }}
      />
      <span>{DELIVERY_STATUS_LABEL[status]}</span>
    </span>
  );
}
