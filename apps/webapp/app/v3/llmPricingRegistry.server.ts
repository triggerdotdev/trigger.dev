import { ModelPricingRegistry, seedLlmPricing } from "@internal/llm-model-catalog";
import { prisma, $replica } from "~/db.server";
import { env } from "~/env.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { setLlmPricingRegistry } from "./utils/enrichCreatableEvents.server";

async function initRegistry(registry: ModelPricingRegistry) {
  if (env.LLM_PRICING_SEED_ON_STARTUP) {
    await seedLlmPricing(prisma);
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
  const interval = setInterval(() => {
    registry.reload().catch((err) => {
      console.error("Failed to reload LLM pricing registry", err);
    });
  }, reloadInterval);

  signalsEmitter.on("SIGTERM", () => {
    clearInterval(interval);
  });
  signalsEmitter.on("SIGINT", () => {
    clearInterval(interval);
  });

  return registry;
});

/**
 * Wait for the LLM pricing registry to finish its initial load, with a timeout.
 * After the first call resolves (or times out), subsequent calls are no-ops.
 */
export async function waitForLlmPricingReady(): Promise<void> {
  if (!llmPricingRegistry || llmPricingRegistry.isLoaded) return;

  const timeoutMs = env.LLM_PRICING_READY_TIMEOUT_MS;
  if (timeoutMs <= 0) return;

  await Promise.race([
    llmPricingRegistry.isReady,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
