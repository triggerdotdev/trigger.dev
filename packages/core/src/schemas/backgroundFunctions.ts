import { z } from "zod";

export const BackgroundFunctionTaskParamsSchema = z.object({
  id: z.string(),
  version: z.string(),
  payload: z.any(),
});
