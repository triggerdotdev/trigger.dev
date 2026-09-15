import { type WebhookEndpointStatus } from "@trigger.dev/database";

const ENDPOINT_STATUS_COLOR: Record<WebhookEndpointStatus, string> = {
  ACTIVE: "#28BF5C",
  INACTIVE: "#878C99",
  DELETING: "#F59E0B",
};

const ENDPOINT_STATUS_LABEL: Record<WebhookEndpointStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  DELETING: "Deleting",
};

export function EndpointStatusBadge({ status }: { status: WebhookEndpointStatus }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: ENDPOINT_STATUS_COLOR[status] }}
      />
      <span>{ENDPOINT_STATUS_LABEL[status]}</span>
    </span>
  );
}
