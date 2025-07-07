import { z } from "zod";
import { TestTaskData } from "./testTask";

export const RunTemplateData = TestTaskData.and(
  z.object({
    label: z.string(),
  })
);

export type RunTemplateData = z.infer<typeof RunTemplateData>;
