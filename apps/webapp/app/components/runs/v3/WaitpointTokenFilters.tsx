import { z } from "zod";

export const WaitpointFilterStatus = z.enum(["PENDING", "COMPLETED", "FAILED"]);
export type WaitpointFilterStatus = z.infer<typeof WaitpointFilterStatus>;

export const WaitpointSearchParamsSchema = z.object({
  friendlyId: z.string().optional(),
  statuses: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    WaitpointFilterStatus.array().optional()
  ),
  idempotencyKey: z.string().optional(),
  tags: z.string().array().optional(),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  cursor: z.string().optional(),
  direction: z.enum(["forward", "backward"]).optional(),
});
