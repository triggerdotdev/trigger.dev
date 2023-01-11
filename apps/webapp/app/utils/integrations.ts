import type { Provider } from "internal-providers";

export function getIntegration(integrations: Provider[], service?: string) {
  return integrations.find((i) => i.slug === service);
}
