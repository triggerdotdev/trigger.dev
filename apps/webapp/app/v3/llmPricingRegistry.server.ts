import { ModelPricingRegistry, seedLlmPricing } from "@internal/llm-pricing";
import { prisma, $replica } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { setLlmPricingRegistry } from "./utils/enrichCreatableEvents.server";

async function initRegistry(registry: ModelPricingRegistry) {
  if (env.LLM_PRICING_SEED_ON_STARTUP) {
    const result = await seedLlmPricing(prisma);
  }

  await registry.loadFromDatabase();
}

export const llmPricingRegistry = singleton("llmPricingRegistry", () => {
  if (!env.LLM_COST_TRACKING_ENABLED) {
    return null;
  }

  const registry = new ModelPricingRegistry($replica);

  // Wire up the registry so enrichCreatableEvents can use it
  setLlmPricingRegistry(registry);

  initRegistry(registry).catch((err) => {
    console.error("Failed to initialize LLM pricing registry", err);
  });

  // Periodic reload
  const reloadInterval = env.LLM_PRICING_RELOAD_INTERVAL_MS;
  setInterval(() => {
    registry
      .reload()
      .then(() => {
      })
      .catch((err) => {
        console.error("Failed to reload LLM pricing registry", err);
      });
  }, reloadInterval);

  return registry;
});
