import { ModelPricingRegistry, seedLlmPricing } from "@internal/llm-model-catalog";
import { prisma, $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { llmRegistryPubSub } from "./services/llmRegistryPubSub.server";
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

  // Periodic reload — acts as a backstop in case a pub/sub message is missed
  // (e.g. during a Redis failover). The primary reload path is the pub/sub
  // subscriber below which reacts within seconds of an admin mutation or a
  // trigger.dev task upserting rows.
  const reloadInterval = env.LLM_PRICING_RELOAD_INTERVAL_MS;
  const interval = setInterval(() => {
    registry.reload().catch((err) => {
      console.error("Failed to reload LLM pricing registry", err);
    });
  }, reloadInterval);

  // Realtime reloads across webapp replicas. Publishers include admin routes
  // and the billing-app trigger.dev LLM registry tasks (via the
  // /admin/api/v1/llm-models/reload endpoint).
  let unsubscribe: (() => Promise<void>) | undefined;
  llmRegistryPubSub
    .subscribe(async (reason) => {
      logger.info("Reloading LLM pricing registry from pub/sub", { reason });
      await registry.reload();
    })
    .then((fn) => {
      unsubscribe = fn;
    })
    .catch((err) => {
      logger.error("Failed to subscribe to llm-registry reload channel", { error: err });
    });

  const cleanup = () => {
    clearInterval(interval);
    unsubscribe?.().catch(() => undefined);
  };

  signalsEmitter.on("SIGTERM", cleanup);
  signalsEmitter.on("SIGINT", cleanup);

  return registry;
});

/**
 * Publish a reload event so every webapp replica reloads its registry. Safe to
 * call after any admin mutation; the pub/sub message is tiny and subscribers
 * deduplicate via the in-memory patterns list.
 */
export async function publishLlmRegistryReload(reason: string): Promise<void> {
  if (!env.LLM_COST_TRACKING_ENABLED) return;
  await llmRegistryPubSub.publishReload(reason);
}

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
