import { z } from "zod";

const ProjectRefSchema = z
  .string()
  .describe(
    "The trigger.dev project ref, starts with proj_. We will attempt to automatically detect the project ref if running inside a directory that includes a trigger.config.ts file, or if you pass the --project-ref option to the MCP server."
  )
  .optional();

export const CommonProjectsInput = z.object({
  projectRef: ProjectRefSchema,
  configPath: z
    .string()
    .describe(
      "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
    )
    .optional(),
  environment: z
    .enum(["dev", "staging", "prod", "preview"])
    .describe("The environment to get tasks for")
    .default("dev"),
  branch: z
    .string()
    .describe(
      "The branch to get tasks for, only used for preview environments and branchable development environments"
    )
    .optional(),
});

export type CommonProjectsInput = z.output<typeof CommonProjectsInput>;

export const CommonRunsInput = CommonProjectsInput.extend({
  runId: z.string().describe("The ID of the run to get the details of, starts with run_"),
});
