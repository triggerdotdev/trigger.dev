import { z } from "zod";

export type TtlWorkerCatalogOptions = {
  visibilityTimeoutMs?: number;
  batchMaxSize?: number;
  batchMaxWaitMs?: number;
};

export function createTtlWorkerCatalog(options?: TtlWorkerCatalogOptions) {
  return {
    expireTtlRun: {
      schema: z.object({
        runId: z.string(),
        orgId: z.string(),
        queueKey: z.string(),
        // The versioned snapshotRoute the TTL Lua copied from the queue message. Passed through as an
        // untrusted wire value and validated with parseSnapshotRoute at the point of use: a valid route
        // means a resident run (per-run expiry protocol), absent means a never-enrolled Postgres run
        // (bulk SQL), and a present-but-malformed route fails closed rather than flipping to Postgres.
        snapshotRoute: z.unknown().optional(),
      }),
      visibilityTimeoutMs: options?.visibilityTimeoutMs ?? 120_000,
      batch: {
        maxSize: options?.batchMaxSize ?? 50,
        maxWaitMs: options?.batchMaxWaitMs ?? 5_000,
      },
    },
  };
}
