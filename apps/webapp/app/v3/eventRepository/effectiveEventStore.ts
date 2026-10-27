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
