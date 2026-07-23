import type { WorkloadConfig } from "../../fairness-spike/harness/workload.js";

/**
 * Concurrency-key scenarios. Each "tenant" in the workload is a concurrency key
 * under one shared base queue. All keys are equal weight (concurrency keys carry
 * no configured weight in production). Seed is set per-run by the bench.
 */
export const CK_SCENARIOS: Record<string, Omit<WorkloadConfig, "seed">> = {
  // The direct #2617 reproduction: one key with a big backlog vs many light keys.
  ckSkew: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "heavy", runCount: 240, holdMsMean: 25 },
      { tenantId: "light-1", runCount: 15, holdMsMean: 25 },
      { tenantId: "light-2", runCount: 15, holdMsMean: 25 },
      { tenantId: "light-3", runCount: 15, holdMsMean: 25 },
      { tenantId: "light-4", runCount: 15, holdMsMean: 25 },
    ],
  },

  ckBalanced: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "k-a", runCount: 60, holdMsMean: 25 },
      { tenantId: "k-b", runCount: 60, holdMsMean: 25 },
      { tenantId: "k-c", runCount: 60, holdMsMean: 25 },
      { tenantId: "k-d", runCount: 60, holdMsMean: 25 },
    ],
  },

  // A bulk key plus keys whose runs trickle in, to exercise wait and CoDel.
  ckTrickle: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "bulk", runCount: 240, holdMsMean: 25 },
      { tenantId: "trickle-1", runCount: 30, arrival: "poisson", ratePerSec: 25, holdMsMean: 25 },
      { tenantId: "trickle-2", runCount: 30, arrival: "poisson", ratePerSec: 25, holdMsMean: 25 },
    ],
  },
};
