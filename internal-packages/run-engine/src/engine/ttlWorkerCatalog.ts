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
      }),
      visibilityTimeoutMs: options?.visibilityTimeoutMs ?? 120_000,
      batch: {
        maxSize: options?.batchMaxSize ?? 50,
        maxWaitMs: options?.batchMaxWaitMs ?? 5_000,
      },
    },
  };
}

export const ttlWorkerCatalog = createTtlWorkerCatalog();
