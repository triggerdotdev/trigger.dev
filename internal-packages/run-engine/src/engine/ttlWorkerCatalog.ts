import { z } from "zod";

export const ttlWorkerCatalog = {
  expireTtlRun: {
    schema: z.object({
      runId: z.string(),
      orgId: z.string(),
      queueKey: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
  },
};
