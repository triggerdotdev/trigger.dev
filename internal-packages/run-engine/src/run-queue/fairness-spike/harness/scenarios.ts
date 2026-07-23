import type { WorkloadConfig } from "./workload.js";

/**
 * Named workloads. All seeded for determinism. A "tenant" is the fairness group;
 * `queueCount` is how many base queues that tenant owns. The adversarial
 * scenario gives one tenant many queues, which is how the #2617 starvation
 * (a tenant multiplying its selection chances) shows up at the base-queue grain.
 */
export const SCENARIOS: Record<string, Omit<WorkloadConfig, "seed">> = {
  balanced: {
    envConcurrencyLimit: 5,
    tenants: [
      { tenantId: "t-a", runCount: 50, holdMsMean: 30 },
      { tenantId: "t-b", runCount: 50, holdMsMean: 30 },
      { tenantId: "t-c", runCount: 50, holdMsMean: 30 },
      { tenantId: "t-d", runCount: 50, holdMsMean: 30 },
    ],
  },

  adversarialSkew: {
    envConcurrencyLimit: 5,
    tenants: [
      { tenantId: "heavy", runCount: 250, queueCount: 30, holdMsMean: 25 },
      { tenantId: "light-1", runCount: 20, holdMsMean: 25 },
      { tenantId: "light-2", runCount: 20, holdMsMean: 25 },
      { tenantId: "light-3", runCount: 20, holdMsMean: 25 },
      { tenantId: "light-4", runCount: 20, holdMsMean: 25 },
      { tenantId: "light-5", runCount: 20, holdMsMean: 25 },
    ],
  },

  weighted: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "big", runCount: 300, weight: 3, holdMsMean: 30 },
      { tenantId: "small", runCount: 300, weight: 1, holdMsMean: 30 },
    ],
  },

  burst: {
    envConcurrencyLimit: 6,
    tenants: Array.from({ length: 6 }, (_, i) => ({
      tenantId: `burst-${i}`,
      runCount: 100,
      startAtMs: 500,
      holdMsMean: 20,
    })),
  },

  longHold: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "slow-1", runCount: 40, holdMsMean: 500 },
      { tenantId: "slow-2", runCount: 40, holdMsMean: 500 },
      { tenantId: "fast-1", runCount: 40, holdMsMean: 20 },
      { tenantId: "fast-2", runCount: 40, holdMsMean: 20 },
    ],
  },

  // A bulk backlog whose heads stay old, plus light tenants trickling in later
  // whose runs then wait. This makes the baseline's age bias live and gives a
  // CoDel wrapper divergent per-tenant sojourns to react to.
  trickleStale: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "heavy", runCount: 300, queueCount: 20, holdMsMean: 25 },
      { tenantId: "trickle-1", runCount: 30, arrival: "poisson", ratePerSec: 25, holdMsMean: 25 },
      { tenantId: "trickle-2", runCount: 30, arrival: "poisson", ratePerSec: 25, holdMsMean: 25 },
    ],
  },
};
