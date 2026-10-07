import { z } from "zod";

export type TtlWorkerCatalogOptions = {
  visibilityTimeoutMs?: number;
  batchMaxSize?: number;
  batchMaxWaitMs?: number;
};

const ExpireTtlRunSchema = z.compile(
  z.object({
    runId: z.string(),
    orgId: z.string(),
    queueKey: z.string(),
    snapshotRoute: z.unknown().optional(),
  })
);

export function createTtlWorkerCatalog(options?: TtlWorkerCatalogOptions) {
  return {
    expireTtlRun: {
      schema: ExpireTtlRunSchema,
      visibilityTimeoutMs: options?.visibilityTimeoutMs ?? 120_000,
      batch: {
        maxSize: options?.batchMaxSize ?? 50,
        maxWaitMs: options?.batchMaxWaitMs ?? 5_000,
      },
    },
  };
}
