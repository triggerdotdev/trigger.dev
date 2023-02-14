import type { ServiceMetadata } from "@trigger.dev/integration-sdk";

export function findIntegrationMetadata(
  integrations: Array<ServiceMetadata>,
  slug: string
) {
  return integrations.find((i) => i.slug === slug);
}
