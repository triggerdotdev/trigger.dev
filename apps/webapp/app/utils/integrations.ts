import type { CatalogIntegration } from "internal-providers";

export function getIntegration(
  integrations: CatalogIntegration[],
  service: string
) {
  return integrations.find((i) => i.slug === service);
}
