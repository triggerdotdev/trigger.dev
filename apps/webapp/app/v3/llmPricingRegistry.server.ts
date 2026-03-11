import { ModelPricingRegistry, seedLlmPricing } from "@internal/llm-pricing";
import { trail } from "agentcrumbs"; // @crumbs
import { prisma, $replica } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { setLlmPricingRegistry } from "./utils/enrichCreatableEvents.server";

const crumb = trail("webapp:llm-registry"); // @crumbs

async function initRegistry(registry: ModelPricingRegistry) {
  if (env.LLM_PRICING_SEED_ON_STARTUP) {
    crumb("seeding llm pricing on startup"); // @crumbs
    const result = await seedLlmPricing(prisma);
    crumb("seed complete", { modelsCreated: result.modelsCreated, modelsSkipped: result.modelsSkipped }); // @crumbs
  }

  await registry.loadFromDatabase();
  crumb("registry loaded successfully", { isLoaded: registry.isLoaded }); // @crumbs
}

export const llmPricingRegistry = singleton("llmPricingRegistry", () => {
  if (!env.LLM_COST_TRACKING_ENABLED) {
    crumb("llm cost tracking disabled via env"); // @crumbs
    return null;
  }

  crumb("initializing registry singleton"); // @crumbs
  const registry = new ModelPricingRegistry($replica);

  // Wire up the registry so enrichCreatableEvents can use it
  setLlmPricingRegistry(registry);

  initRegistry(registry).catch((err) => {
    crumb("registry init failed", { error: String(err) }); // @crumbs
    console.error("Failed to initialize LLM pricing registry", err);
  });

  // Periodic reload
  const reloadInterval = env.LLM_PRICING_RELOAD_INTERVAL_MS;
  setInterval(() => {
    registry
      .reload()
      .then(() => {
        crumb("registry reloaded"); // @crumbs
      })
      .catch((err) => {
        crumb("registry reload failed", { error: String(err) }); // @crumbs
        console.error("Failed to reload LLM pricing registry", err);
      });
  }, reloadInterval);

  return registry;
});
