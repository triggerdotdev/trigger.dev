import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { runCkScenario } from "../harness/ckDriver.js";
import { buildWorkload } from "../../fairness-spike/harness/workload.js";
import { BaselineCk, SfqCk } from "../disciplines.js";

describe("ck driver smoke + fidelity", () => {
  redisTest(
    "baseline starves light keys (age order); SFQ fixes it",
    async ({ redisContainer }) => {
      const redis = {
        keyPrefix: "rq:ck-smoke:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      };
      // one heavy concurrency key with a big backlog, three light keys
      const workload = buildWorkload({
        seed: "ck-smoke",
        envConcurrencyLimit: 3,
        tenants: [
          { tenantId: "heavy", runCount: 90, holdMsMean: 25 },
          { tenantId: "light-1", runCount: 10, holdMsMean: 25 },
          { tenantId: "light-2", runCount: 10, holdMsMean: 25 },
          { tenantId: "light-3", runCount: 10, holdMsMean: 25 },
        ],
      });
      const total = 120;

      const baseline = await runCkScenario({ redis, discipline: new BaselineCk(), workload });
      const sfq = await runCkScenario({ redis, discipline: new SfqCk(), workload });

      // full drain both ways (harness health)
      expect(baseline.totalDequeued).toBe(total);
      expect(sfq.totalDequeued).toBe(total);

      // fidelity: baseline age-order lets the heavy key dominate contention, so a
      // light key is under-served; SFQ gives the light keys their fair share
      expect(baseline.contentionWorstShareOverWeight).toBeLessThan(0.6);
      expect(sfq.contentionWorstShareOverWeight).toBeGreaterThan(
        baseline.contentionWorstShareOverWeight + 0.2
      );
    },
    120_000
  );
});
