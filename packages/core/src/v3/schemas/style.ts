import { z } from "zod";

export const LOW_PROMINENCE = "low";
export const HIGH_PROMINENCE = "high";

const Prominence = z.enum([LOW_PROMINENCE, HIGH_PROMINENCE]);
export type Prominence = z.infer<typeof Prominence>;

export const TaskEventStyle = z
  .object({
    icon: z.string().optional(),
    prominence: Prominence.default(LOW_PROMINENCE),
  })
  .default({
    icon: undefined,
    prominence: LOW_PROMINENCE,
  });

export type TaskEventStyle = z.infer<typeof TaskEventStyle>;
