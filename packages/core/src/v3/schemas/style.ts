import { z } from "zod";

export const TaskEventStyle = z
  .object({
    icon: z.string().optional(),
  })
  .optional();
