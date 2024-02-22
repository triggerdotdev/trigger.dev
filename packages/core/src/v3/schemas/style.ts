import { z } from "zod";

export const TASK_VARIANT = "task";
export const ATTEMPT_VARIANT = "attempt";

const Variant = z.enum([TASK_VARIANT, ATTEMPT_VARIANT]);
export type Variant = z.infer<typeof Variant>;

export const TaskEventStyle = z
  .object({
    icon: z.string().optional(),
    variant: Variant.optional(),
  })
  .default({
    icon: undefined,
    variant: undefined,
  });

export type TaskEventStyle = z.infer<typeof TaskEventStyle>;
