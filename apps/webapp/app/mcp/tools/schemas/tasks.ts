import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const GetTaskSchemaInput = CommonProjectsInput.extend({
  taskSlug: z
    .string()
    .describe(
      "The task slug/identifier to get the payload schema for. Use get_current_worker to see available tasks."
    ),
});

export type GetTaskSchemaInput = z.output<typeof GetTaskSchemaInput>;
