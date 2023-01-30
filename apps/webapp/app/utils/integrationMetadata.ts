import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";

export function findIntegrationMetadata(
  integrations: Array<IntegrationMetadata>,
  slug: string
) {
  return integrations.find((i) => i.slug === slug);
}
