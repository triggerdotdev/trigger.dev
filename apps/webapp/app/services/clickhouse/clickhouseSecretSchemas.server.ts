import { z } from "zod";

export const ClickhouseConnectionSchema = z.object({
  url: z.string().url(),
  /** Writes also go to this URL so the store can move to another ClickHouse service without a gap. */
  mirrorUrl: z.string().url().optional(),
});
