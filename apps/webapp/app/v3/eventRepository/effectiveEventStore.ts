/**
 * The store a run's events are actually written to and read from. With the reroute on, the legacy
 * "clickhouse" store (task_events_v1) resolves to "clickhouse_v2"; every other value is unchanged.
 */
export function effectiveEventStore(store: string, v1RerouteEnabled: boolean): string {
  if (v1RerouteEnabled && store === "clickhouse") {
    return "clickhouse_v2";
  }

  return store;
}

const LEGACY_STORE_DOCS_URL =
  "https://trigger.dev/docs/self-hosting/docker#move-from-the-legacy-clickhouse-store";

/** Startup warning for instances still configured with the retired "clickhouse" store. */
export function legacyEventStoreWarning(
  defaultStore: string,
  v1RerouteEnabled: boolean
): string | undefined {
  if (defaultStore !== "clickhouse") {
    return undefined;
  }

  if (v1RerouteEnabled) {
    return `⚠️  EVENT_REPOSITORY_DEFAULT_STORE=clickhouse is retired: task events now go to clickhouse_v2. Set EVENT_REPOSITORY_DEFAULT_STORE=clickhouse_v2, and copy older events over if you want to keep them: ${LEGACY_STORE_DOCS_URL}`;
  }

  return `⚠️  EVENT_REPOSITORY_V1_REROUTE_ENABLED=0 keeps the retired clickhouse event store. This is temporary: switch to EVENT_REPOSITORY_DEFAULT_STORE=clickhouse_v2 before it's removed: ${LEGACY_STORE_DOCS_URL}`;
}

export const LEGACY_FLAG_STORE_WARNING = `⚠️  A taskEventRepository feature flag still selects the retired clickhouse event store. Set it to clickhouse_v2, and copy older events over if you want to keep them: ${LEGACY_STORE_DOCS_URL}`;
