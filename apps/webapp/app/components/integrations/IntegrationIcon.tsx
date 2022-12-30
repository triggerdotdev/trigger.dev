import type { CatalogIntegration } from "internal-catalog";

export function IntegrationIcon({
  integration,
}: {
  integration: CatalogIntegration;
}) {
  return (
    <img
      src={integration.icon}
      alt={integration.name}
      className="h-5 w-5 shadow-lg group-hover:opacity-80 transition"
    />
  );
}
