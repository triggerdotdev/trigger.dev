import type { SerializableProvider } from "@trigger.dev/providers";

export function getIntegration(
  integrations: SerializableProvider[],
  service?: string
) {
  return integrations.find((i) => i.slug === service);
}
