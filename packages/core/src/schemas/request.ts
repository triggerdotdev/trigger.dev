import { z } from "zod";

export const RequestWithRawBodySchema = z.object({
  url: z.string(),
  method: z.string(),
  headers: z.record(z.string()),
  rawBody: z.string(),
});
