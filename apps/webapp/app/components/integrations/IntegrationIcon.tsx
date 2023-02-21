import type { ServiceMetadata } from "@trigger.dev/integration-sdk";

export function IntegrationIcon({
  integration,
}: {
  integration: ServiceMetadata;
}) {
  return (
    <img
      src={integration.icon}
      alt={integration.name}
      className="h-5 w-5 shadow-lg transition group-hover:opacity-80"
    />
  );
}
