import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";

export function IntegrationIcon({
  integration,
}: {
  integration: IntegrationMetadata;
}) {
  return (
    <img
      src={integration.icon}
      alt={integration.name}
      className="h-5 w-5 shadow-lg group-hover:opacity-80 transition"
    />
  );
}
