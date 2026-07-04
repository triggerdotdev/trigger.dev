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
      "RUN_OPS_SPLIT_ENABLED is on but RUN_OPS_LEGACY_DATABASE_URL / RUN_OPS_DATABASE_URL are not both set; staying single-DB."
    );
    return false;
  }
  // Hard gate #2: runtime sentinel must confirm physically-distinct DBs.
  const probe = deps.probe ?? defaultProbe;
  const result = await probe(config.legacyUrl, config.newUrl, { logger: deps.logger });
  return result.distinct === true;
}

export type SplitRealtimeInterlockConfig = {
  splitEnabled: boolean;
  nativeRealtimeEnabled: boolean;
};

/**
 * Boot-time realtime interlock (pure predicate). Split mode puts NEW-resident
 * (ksuid) runs on the dedicated run-ops DB, but Electric replicates only from the
 * control-plane DB — with the native realtime backend OFF those runs are invisible
 * and every realtime subscription hangs. Refuse split unless native is on; split-off
 * is always allowed regardless of the realtime backend.
 */
export function assertSplitRealtimeInterlock(config: SplitRealtimeInterlockConfig): void {
  if (!config.splitEnabled) {
    return;
  }
  if (!config.nativeRealtimeEnabled) {
    throw new Error(
      "RUN_OPS_SPLIT_ENABLED is on but the native realtime backend (REALTIME_BACKEND_NATIVE_ENABLED) is not enabled — Electric cannot serve NEW-resident runs; refusing to enable split."
    );
  }
}

let cached: Promise<boolean> | undefined;

export function isSplitEnabled(): Promise<boolean> {
  if (!cached) {
    cached = computeSplitEnabled(
      {
        flagEnabled: env.RUN_OPS_SPLIT_ENABLED,
        legacyUrl: env.RUN_OPS_LEGACY_DATABASE_URL,
        newUrl: env.RUN_OPS_DATABASE_URL,
      },
      { logger }
    );
  }
  return cached;
}

export function __resetSplitModeCacheForTests(): void {
  cached = undefined;
}
