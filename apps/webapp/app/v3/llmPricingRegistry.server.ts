import { ModelPricingRegistry, seedLlmPricing } from "@internal/llm-model-catalog";
import type { LlmModelWithPricing } from "@internal/llm-model-catalog";
import { prisma, $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import { createRedisClient } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import { setLlmPricingRegistry } from "./utils/enrichCreatableEvents.server";

type PricingReloadListener = (models: LlmModelWithPricing[]) => void;
const pricingReloadListeners = new Set<PricingReloadListener>();

// Notify subscribers (e.g. the OTLP worker pool) after each load/reload so they can rebuild
// their own in-memory copy. No-op until something subscribes.
function emitPricingReload() {
  if (!llmPricingRegistry || !llmPricingRegistry.isLoaded || pricingReloadListeners.size === 0) {
    return;
  }
  const models = llmPricingRegistry.toSerializable();
  for (const listener of pricingReloadListeners) {
    try {
      listener(models);
    } catch (err) {
      logger.warn("LLM pricing reload listener failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function subscribeToPricingReload(listener: PricingReloadListener): () => void {
  pricingReloadListeners.add(listener);
  if (llmPricingRegistry?.isLoaded) {
    try {
      listener(llmPricingRegistry.toSerializable());
    } catch (err) {
      logger.warn("LLM pricing reload listener failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return () => {
    pricingReloadListeners.delete(listener);
  };
}

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

  initRegistry(registry)
    .then(() => emitPricingReload())
    .catch((err) => {
      console.error("Failed to initialize LLM pricing registry", err);
    });

  // Periodic reload (backstop for the pub/sub path below)
  const reloadInterval = env.LLM_PRICING_RELOAD_INTERVAL_MS;
  const interval = setInterval(() => {
    registry
      .reload()
      .then(() => emitPricingReload())
      .catch((err) => {
        console.error("Failed to reload LLM pricing registry", err);
      });
  }, reloadInterval);

  // Pub/sub reload is opt-in per process (default off). Without it, the
  // registry stays accurate via the existing 5-minute interval. Enable on
  // the OTel-ingesting services where pricing freshness directly affects
  // span cost enrichment; dashboard and worker services don't need it and
  // shouldn't pile onto each publish with a full-table reload.
  if (env.LLM_PRICING_RELOAD_PUBSUB_ENABLED) {
    const subscriber = createRedisClient("llm-pricing:subscriber", {
      keyPrefix: "llm-pricing:subscriber:",
      host: env.COMMON_WORKER_REDIS_HOST,
      port: env.COMMON_WORKER_REDIS_PORT,
      username: env.COMMON_WORKER_REDIS_USERNAME,
      password: env.COMMON_WORKER_REDIS_PASSWORD,
      tlsDisabled: env.COMMON_WORKER_REDIS_TLS_DISABLED === "true",
      clusterMode: env.COMMON_WORKER_REDIS_CLUSTER_MODE_ENABLED === "1",
    });

    subscriber.subscribe(env.LLM_PRICING_RELOAD_CHANNEL).catch((err) => {
      logger.warn("Failed to subscribe to LLM pricing reload channel", {
        channel: env.LLM_PRICING_RELOAD_CHANNEL,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Coalesce reload calls so a burst of publishes only triggers one
    // reload. The first publish schedules a reload at
    // T+LLM_PRICING_RELOAD_DEBOUNCE_MS; subsequent publishes during that
    // window are no-ops because the trailing reload picks up everything
    // when it queries the DB. Bounds reload rate to at most 1 per debounce
    // window regardless of publisher chattiness.
    const debounceMs = env.LLM_PRICING_RELOAD_DEBOUNCE_MS;
    let pendingReloadTimer: NodeJS.Timeout | null = null;

    function scheduleReload() {
      if (pendingReloadTimer) return;
      pendingReloadTimer = setTimeout(() => {
        pendingReloadTimer = null;
        registry
          .reload()
          .then(() => emitPricingReload())
          .catch((err) => {
            logger.warn("Failed to reload LLM pricing registry from pub/sub", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }, debounceMs);
    }

    subscriber.on("message", (channel) => {
      if (channel !== env.LLM_PRICING_RELOAD_CHANNEL) return;
      scheduleReload();
    });

    signalsEmitter.on("SIGTERM", () => {
      clearInterval(interval);
      if (pendingReloadTimer) clearTimeout(pendingReloadTimer);
      void subscriber.quit().catch(() => {});
    });
    signalsEmitter.on("SIGINT", () => {
      clearInterval(interval);
      if (pendingReloadTimer) clearTimeout(pendingReloadTimer);
      void subscriber.quit().catch(() => {});
    });
  } else {
    signalsEmitter.on("SIGTERM", () => clearInterval(interval));
    signalsEmitter.on("SIGINT", () => clearInterval(interval));
  }

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
