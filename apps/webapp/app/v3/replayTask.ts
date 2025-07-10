import { z } from "zod";
import { RunOptionsData } from "./testTask";

export const ReplayTaskData = z
  .object({
    environment: z.string().optional(),
    payload: z.string().optional(),
    metadata: z.string().optional(),
    failedRedirect: z.string(),
  })
  .and(RunOptionsData);

export type ReplayTaskData = z.infer<typeof ReplayTaskData>;
