import { z } from "zod";
import { TestTaskData } from "./testTask";

export const RunTemplateData = TestTaskData.and(
  z.object({
    label: z.string().max(42, "Labels can be at most 42 characters long"),
  })
);

export type RunTemplateData = z.infer<typeof RunTemplateData>;

export const DeleteTaskRunTemplateData = z.object({
  templateId: z.string(),
});
