import type { Provider } from "@trigger.dev/providers";

export function getIntegration(integrations: Provider[], service?: string) {
  return integrations.find((i) => i.slug === service);
}
