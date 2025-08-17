import {
  ApiDeploymentListParams,
  MachinePresetName,
  RunStatus,
} from "@trigger.dev/core/v3/schemas";
import { z } from "zod";

export const ProjectRefSchema = z
  .string()
  .describe(
    "The trigger.dev project ref, starts with proj_. We will attempt to automatically detect the project ref if running inside a directory that includes a trigger.config.ts file, or if you pass the --project-ref option to the MCP server."
  )
  .optional();

export const CreateProjectInOrgInput = z.object({
  orgParam: z
    .string()
    .describe(
      "The organization to create the project in, can either be the organization slug or the ID. Use the list_orgs tool to get a list of organizations and ask the user to select one."
    ),
  name: z.string().describe("The name of the project to create."),
});

export type CreateProjectInOrgInput = z.output<typeof CreateProjectInOrgInput>;

export const InitializeProjectInput = z.object({
  orgParam: z
    .string()
    .describe(
      "The organization to create the project in, can either be the organization slug or the ID. Use the list_orgs tool to get a list of organizations and ask the user to select one."
    ),
  projectRef: ProjectRefSchema,
  projectName: z
    .string()
    .describe(
      "The name of the project to create. If projectRef is not provided, we will use this name to create a new project in the organization you select."
    ),
  cwd: z.string().describe("The current working directory of the project").optional(),
});

export type InitializeProjectInput = z.output<typeof InitializeProjectInput>;

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
    .describe("The branch to get tasks for, only used for preview environments")
    .optional(),
});

export type CommonProjectsInput = z.output<typeof CommonProjectsInput>;

export const TriggerTaskInput = CommonProjectsInput.extend({
  taskId: z
    .string()
    .describe(
      "The ID/slug of the task to trigger. Use the get_tasks tool to get a list of tasks and ask the user to select one if it's not clear which one to use."
    ),
  payload: z
    .string()
    .transform((val, ctx) => {
      try {
        return JSON.parse(val);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The payload must be a valid JSON string",
        });
        return z.NEVER;
      }
    })
    .describe("The payload to trigger the task with, must be a valid JSON string"),
  options: z
    .object({
      queue: z
        .object({
          name: z
            .string()
            .describe(
              "The name of the queue to trigger the task in, by default will use the queue configured in the task"
            ),
        })
        .optional(),
      delay: z
        .string()
        .or(z.coerce.date())
        .describe("The delay before the task run is executed")
        .optional(),
      idempotencyKey: z.string().describe("The idempotency key to use for the task run").optional(),
      machine: MachinePresetName.describe("The machine preset to use for the task run").optional(),
      maxAttempts: z
        .number()
        .int()
        .describe("The maximum number of attempts to retry the task run")
        .optional(),
      maxDuration: z
        .number()
        .describe("The maximum duration in seconds of the task run")
        .optional(),
      tags: z
        .array(z.string())
        .describe(
          "Tags to add to the task run. Must be less than 128 characters and cannot have more than 5"
        )
        .optional(),
      ttl: z
        .string()
        .or(z.number().nonnegative().int())
        .describe(
          "The time to live of the task run. If the run doesn't start executing within this time, it will be automatically cancelled."
        )
        .default("10m"),
    })
    .optional(),
});

export type TriggerTaskInput = z.output<typeof TriggerTaskInput>;

export const CommonRunsInput = CommonProjectsInput.extend({
  runId: z.string().describe("The ID of the run to get the details of, starts with run_"),
});

export type CommonRunsInput = z.output<typeof CommonRunsInput>;

export const GetRunDetailsInput = CommonRunsInput.extend({
  debugMode: z
    .boolean()
    .describe(
      "Enable debug mode to get more detailed information about the run, including the entire trace (all logs and spans for the run and any child run). Set this to true if prompted to debug a run."
    )
    .optional(),
});

export type GetRunDetailsInput = z.output<typeof GetRunDetailsInput>;

export const ListRunsInput = CommonProjectsInput.extend({
  cursor: z.string().describe("The cursor to use for pagination, starts with run_").optional(),
  limit: z
    .number()
    .int()
    .describe("The number of runs to list in a single page. Up to 100")
    .optional(),
  status: RunStatus.describe("Filter for runs with this run status").optional(),
  taskIdentifier: z.string().describe("Filter for runs that match this task identifier").optional(),
  version: z
    .string()
    .describe("Filter for runs that match this version, e.g. 20250808.3")
    .optional(),
  tag: z.string().describe("Filter for runs that include this tag").optional(),
  from: z.string().describe("Filter for runs created after this ISO 8601 timestamp").optional(),
  to: z.string().describe("Filter for runs created before this ISO 8601 timestamp").optional(),
  period: z
    .string()
    .describe("Filter for runs created in the last N time period. e.g. 7d, 30d, 365d")
    .optional(),
  machine: MachinePresetName.describe("Filter for runs that match this machine preset").optional(),
});

export type ListRunsInput = z.output<typeof ListRunsInput>;

export const CommonDeployInput = CommonProjectsInput.omit({
  environment: true,
}).extend({
  environment: z
    .enum(["staging", "prod", "preview"])
    .describe("The environment to trigger the task in")
    .default("prod"),
});

export type CommonDeployInput = z.output<typeof CommonDeployInput>;

export const DeployInput = CommonDeployInput.extend({
  skipPromotion: z
    .boolean()
    .describe("Skip promoting the deployment to the current deployment for the environment")
    .optional(),
  skipSyncEnvVars: z
    .boolean()
    .describe("Skip syncing environment variables when using the syncEnvVars extension")
    .optional(),
  skipUpdateCheck: z
    .boolean()
    .describe("Skip checking for @trigger.dev package updates")
    .optional(),
});

export type DeployInput = z.output<typeof DeployInput>;

export const ListDeploysInput = CommonDeployInput.extend(ApiDeploymentListParams);

export type ListDeploysInput = z.output<typeof ListDeploysInput>;

export const ListPreviewBranchesInput = z.object({
  projectRef: ProjectRefSchema,
  configPath: z
    .string()
    .describe(
      "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
    )
    .optional(),
});

export type ListPreviewBranchesInput = z.output<typeof ListPreviewBranchesInput>;
