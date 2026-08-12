/**
 * Pure realtime-streams version resolution. Deliberately free of `env` and of
 * any module-scope singletons so it can be tested with injected values, the
 * same split as `nativeRealtimeClient` and `nativeRealtimeClientInstance`.
 * The env-bound wrapper is `determineRealtimeStreamsVersion` in
 * `v1StreamsGlobal.server.ts`.
 */

export type RealtimeStreamsVersionConfig = {
  defaultVersion: "v1" | "v2";
  /** A basin that will actually resolve at read/write time, or undefined if none will. */
  basin?: string;
  accessToken?: string;
  skipAccessTokens: boolean;
};

/**
 * Resolve the streams version to stamp on a run, falling back to the
 * deployment default when the caller expresses no preference.
 *
 * v2 is only ever returned when S2 can actually serve it. A run stamped v2 on a
 * deployment without S2 is unusable: `getRealtimeStreamInstance` throws for the
 * life of the run, and no read or write against its streams can succeed. v1 is
 * a working backend, so an unsatisfiable v2 degrades to it.
 *
 * The basin must be one that will actually resolve later. Enabling per-org
 * basins is not enough on its own: provisioning is out of band, so an
 * unprovisioned organization has no basin and a global setting may not exist
 * to fall back to.
 */
export function resolveRealtimeStreamsVersion(
  streamVersion: string | undefined,
  config: RealtimeStreamsVersionConfig
): "v1" | "v2" {
  const requested = streamVersion ?? config.defaultVersion;

  if (requested !== "v2") {
    return "v1";
  }

  const hasCredentials = Boolean(config.accessToken) || config.skipAccessTokens;

  return hasCredentials && Boolean(config.basin) ? "v2" : "v1";
}
