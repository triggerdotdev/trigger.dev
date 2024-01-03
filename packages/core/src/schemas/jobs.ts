import { z } from "zod";

export const CancelRunsForJobSchema = z.object({
  cancelledRunIds: z.array(z.string()),
  failedToCancelRunIds: z.array(z.string()),
});

export type CancelRunsForJob = z.infer<typeof CancelRunsForJobSchema>;
