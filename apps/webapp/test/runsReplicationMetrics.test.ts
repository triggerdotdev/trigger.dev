// The alarmable half of the "publication carries no tables" failure: the client reports it, and
// this counter is what turns that report into a series an alert can fire on, per source.
import { PublicationMisconfiguredError } from "@internal/replication";
import { Registry, type RegistryContentType } from "prom-client";
import { describe, expect, it } from "vitest";
import { buildRunsReplicationSourceMetrics } from "~/services/runsReplicationMetrics.server";

function freshRegister() {
  return new Registry<RegistryContentType>();
}

function misconfigured(publicationName: string) {
  return new PublicationMisconfiguredError(
    `Publication '${publicationName}' exists but has NO TABLES configured.`,
    { publicationName, table: "TaskRun" }
  );
}

describe("runs-replication source metrics", () => {
  it("counts a publication misconfiguration against the source that reported it", async () => {
    const register = freshRegister();
    const metrics = buildRunsReplicationSourceMetrics(register);

    metrics.recordSourceError({ sourceId: "shard-a", error: misconfigured("runs_shard_a_pub") });
    metrics.recordSourceError({ sourceId: "shard-a", error: misconfigured("runs_shard_a_pub") });
    metrics.recordSourceError({ sourceId: "new", error: misconfigured("runs_new_pub") });

    const exposed = await register.metrics();
    expect(exposed).toContain(
      'runs_replication_publication_misconfigured_total{source="shard-a"} 2'
    );
    expect(exposed).toContain('runs_replication_publication_misconfigured_total{source="new"} 1');
  });

  it("leaves the counter alone for any other client error", async () => {
    const register = freshRegister();
    const metrics = buildRunsReplicationSourceMetrics(register);

    metrics.recordSourceError({ sourceId: "legacy", error: new Error("connection terminated") });

    const exposed = await register.metrics();
    expect(exposed).not.toContain('source="legacy"');
  });
});
