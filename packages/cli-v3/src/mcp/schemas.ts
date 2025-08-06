import { z } from "zod";

export const ProjectRefSchema = z
  .string()
  .describe(
    "The trigger.dev project ref, starts with proj_. We will attempt to automatically detect the project ref if running inside a directory that includes a trigger.config.ts file, or if you pass the --project-ref option to the MCP server."
  )
  .optional();
