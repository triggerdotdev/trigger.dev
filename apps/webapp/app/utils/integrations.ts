import type { CatalogIntegration } from "internal-catalog";

export function getIntegration(
  integrations: CatalogIntegration[],
  service: string
) {
  return integrations.find((i) => i.slug === service);
}
