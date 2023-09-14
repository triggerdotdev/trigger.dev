import { z } from "zod";

export const BackgroundTaskOperationParamsSchema = z.object({
  id: z.string(),
  version: z.string(),
  payload: z.any(),
});
