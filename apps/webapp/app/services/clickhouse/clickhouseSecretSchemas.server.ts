import { z } from "zod";

export const ClickhouseConnectionSchema = z.object({
  url: z.string().url(),
});
