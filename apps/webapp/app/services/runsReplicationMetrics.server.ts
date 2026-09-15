/**
 * A replication source whose publication carries no usable table replicates nothing while the
 * service stays up and healthy: boot passes, `assertReplicationCoversSplit` only checks that a
 * source is CONFIGURED, and the client's retry loop logs every 30s. Counting it is what makes it
 * alarmable — a non-zero rate here means that source's runs are not reaching ClickHouse.
 */
import { PublicationMisconfiguredError } from "@internal/replication";
import { Counter, type Registry, type RegistryContentType } from "prom-client";
import { metricsRegister } from "~/metrics.server";
import { singleton } from "~/utils/singleton";

export type RunsReplicationSourceMetrics = {
  recordSourceError(info: { sourceId: string; error: unknown }): void;
};

export function buildRunsReplicationSourceMetrics(
  register: Registry<RegistryContentType>
): RunsReplicationSourceMetrics {
  const publicationMisconfigured = new Counter({
    name: "runs_replication_publication_misconfigured_total",
    help: "A replication source's publication does not carry the replicated table, so that source replicates nothing.",
    labelNames: ["source"],
    registers: [register],
  });

  return {
    recordSourceError: ({ sourceId, error }) => {
      if (error instanceof PublicationMisconfiguredError) {
        publicationMisconfigured.inc({ source: sourceId });
      }
    },
  };
}

// singleton: module-scope Counter registration double-registers under dev HMR.
export const runsReplicationSourceMetrics = singleton("runsReplicationSourceMetrics", () =>
  buildRunsReplicationSourceMetrics(metricsRegister)
);
