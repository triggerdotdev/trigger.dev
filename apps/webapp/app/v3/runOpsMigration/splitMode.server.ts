/**
 * isSplitEnabled() is the Wave-0 gate. The entire migration/routing/FK-drop family
 * MUST be unreachable when this returns false. Default is false (single-DB). Never
 * infer split-vs-single from URL string-equality — distinctness is proven by the
 * runtime sentinel.
 */
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { probeDistinctDatabases as defaultProbe } from "./distinctDbSentinel.server";

export type SplitModeConfig = {
  flagEnabled: boolean;
  legacyUrl?: string;
  newUrl?: string;
};

export type SplitModeDeps = {
  probe?: typeof defaultProbe;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
};

export async function computeSplitEnabled(
  config: SplitModeConfig,
  deps: SplitModeDeps = {}
): Promise<boolean> {
  // Hard gate #1: explicit positive opt-in. OFF by default -> never probe.
  if (!config.flagEnabled) {
    return false;
  }
  // Both URLs are required to even consider a split.
  if (!config.legacyUrl || !config.newUrl) {
    deps.logger?.warn(
      "RUN_OPS_SPLIT_ENABLED is on but TASK_RUN_LEGACY_DATABASE_URL / TASK_RUN_DATABASE_URL are not both set; staying single-DB."
    );
    return false;
  }
  // Hard gate #2: runtime sentinel must confirm physically-distinct DBs.
  const probe = deps.probe ?? defaultProbe;
  const result = await probe(config.legacyUrl, config.newUrl, { logger: deps.logger });
  return result.distinct === true;
}

let cached: Promise<boolean> | undefined;

export function isSplitEnabled(): Promise<boolean> {
  if (!cached) {
    cached = computeSplitEnabled(
      {
        flagEnabled: env.RUN_OPS_SPLIT_ENABLED,
        legacyUrl: env.TASK_RUN_LEGACY_DATABASE_URL,
        newUrl: env.TASK_RUN_DATABASE_URL,
      },
      { logger }
    );
  }
  return cached;
}

export function __resetSplitModeCacheForTests(): void {
  cached = undefined;
}
