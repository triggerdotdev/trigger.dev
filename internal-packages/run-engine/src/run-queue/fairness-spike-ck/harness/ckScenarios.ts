import type { WorkloadConfig } from "../../fairness-spike/harness/workload.js";

/**
 * Concurrency-key scenarios. Each "tenant" in the workload is a concurrency key
 * under one shared base queue. All keys are equal weight (concurrency keys carry
 * no configured weight in production). Seed is set per-run by the bench.
 *
 * Every scenario gives keys genuinely divergent head ages (a bulk key with a
 * same-time backlog keeps an old head; other keys arrive via poisson so their
 * heads are distinct and later). This is deliberate: if all runs shared one
 * enqueue timestamp the ckIndex scores would tie and the real Lua's
 * ZRANGEBYSCORE would fall back to a lexicographic member-name tie-break, which
 * would make the baseline look starved for reasons that have nothing to do with
 * age order. We want the baseline to exercise the real age dynamic #2617
 * describes.
 */
export const CK_SCENARIOS: Record<string, Omit<WorkloadConfig, "seed">> = {
  // #2617 classic: one key fires a big backlog at once (its head stays old), four
  // other keys trickle in. Age-order serves the old-headed backlog to exhaustion
  // and starves the others.
  ckSkew: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "heavy", runCount: 240, holdMsMean: 25 },
      { tenantId: "light-1", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
      { tenantId: "light-2", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
      { tenantId: "light-3", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
      { tenantId: "light-4", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
    ],
  },

  // Symmetric keys, all arriving via poisson at the same rate. Baseline should be
  // roughly fair here (no key is systematically older), which is the sanity check.
  ckBalanced: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "k-a", runCount: 60, arrival: "poisson", ratePerSec: 20, holdMsMean: 25 },
      { tenantId: "k-b", runCount: 60, arrival: "poisson", ratePerSec: 20, holdMsMean: 25 },
      { tenantId: "k-c", runCount: 60, arrival: "poisson", ratePerSec: 20, holdMsMean: 25 },
      { tenantId: "k-d", runCount: 60, arrival: "poisson", ratePerSec: 20, holdMsMean: 25 },
    ],
  },

  // A bulk backlog plus two keys trickling in slowly, to exercise wait and CoDel.
  ckTrickle: {
    envConcurrencyLimit: 4,
    tenants: [
      { tenantId: "bulk", runCount: 240, holdMsMean: 25 },
      { tenantId: "trickle-1", runCount: 30, arrival: "poisson", ratePerSec: 25, holdMsMean: 25 },
      { tenantId: "trickle-2", runCount: 30, arrival: "poisson", ratePerSec: 25, holdMsMean: 25 },
    ],
  },
};
