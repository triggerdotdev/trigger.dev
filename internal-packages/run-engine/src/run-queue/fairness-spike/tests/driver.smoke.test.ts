import { redisTest } from "@internal/testcontainers";
import { describe } from "node:test";
import { FairQueueSelectionStrategy } from "../../fairQueueSelectionStrategy.js";
import { RunQueueFullKeyProducer } from "../../keyProducer.js";
import { runScenario } from "../harness/driver.js";
import { buildWorkload } from "../harness/workload.js";

const keys = new RunQueueFullKeyProducer();

describe("driver smoke (baseline)", () => {
  redisTest("balanced workload dequeues every run and is roughly fair", async ({ redisContainer }) => {
    const redis = {
      keyPrefix: "runqueue:spike-smoke:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    };

    const workload = buildWorkload({
      seed: "smoke-1",
      envConcurrencyLimit: 5,
      tenants: [
        { tenantId: "a", runCount: 50, holdMsMean: 30 },
        { tenantId: "b", runCount: 50, holdMsMean: 30 },
        { tenantId: "c", runCount: 50, holdMsMean: 30 },
        { tenantId: "d", runCount: 50, holdMsMean: 30 },
      ],
    });

    const metrics = await runScenario({
      redis,
      strategy: new FairQueueSelectionStrategy({ redis, keys }),
      workload,
    });

    expect(metrics.totalDequeued).toBe(200);
    // balanced, one queue per tenant: baseline should not fully starve anyone
    expect(metrics.worstShareOverWeight).toBeGreaterThan(0.5);
    expect(metrics.perGroup).toHaveLength(4);
  }, 60_000);
});
