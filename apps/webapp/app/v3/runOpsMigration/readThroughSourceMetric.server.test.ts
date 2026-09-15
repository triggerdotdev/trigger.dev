// The per-shard half of read-through observability: /metrics carried no `shard` label at all, so a
// cohort ramp was unobservable. A gen-2 source splits into a constant `source` plus the shard key,
// so one query sums the whole gen-2 cohort and another breaks it down per shard.
import { Registry, type RegistryContentType } from "prom-client";
import { describe, expect, it } from "vitest";
import { buildReadThroughSourceMetric } from "./readThroughSourceMetric.server";

describe("read-through source metric", () => {
  it("labels a gen-2 hit with its shard key", async () => {
    const register = new Registry<RegistryContentType>();
    const record = buildReadThroughSourceMetric(register);

    record("shard:a");
    record("shard:a");
    record("shard:b");

    const exposed = await register.metrics();
    expect(exposed).toContain('runops_read_through_source_total{source="shard",shard="a"} 2');
    expect(exposed).toContain('runops_read_through_source_total{source="shard",shard="b"} 1');
  });

  it("keeps the two gen-1 sources distinguishable and shard-less", async () => {
    const register = new Registry<RegistryContentType>();
    const record = buildReadThroughSourceMetric(register);

    record("new");
    record("legacy-replica");

    const exposed = await register.metrics();
    expect(exposed).toContain('runops_read_through_source_total{source="new",shard="none"} 1');
    expect(exposed).toContain(
      'runops_read_through_source_total{source="legacy-replica",shard="none"} 1'
    );
  });
});
