import { z } from "zod";

export const ScheduleListFilters = z.object({
  page: z.coerce.number().default(1),
  tasks: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  type: z.union([z.literal("declarative"), z.literal("imperative")]).optional(),
  search: z.string().optional(),
});

export type ScheduleListFilters = z.infer<typeof ScheduleListFilters>;
