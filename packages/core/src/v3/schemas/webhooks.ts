import { z } from "zod";
import { MachinePresetName, TaskRunError } from "./common.js";
import { RunStatus } from "./api.js";
import { RuntimeEnvironmentTypeSchema } from "../../schemas/api.js";
import { OutOfMemoryError } from "../errors.js";

/** Represents a failed run alert webhook payload */
const AlertWebhookRunFailedObject = z.object({
  /** Task information */
  task: z.object({
    /** Unique identifier for the task */
    id: z.string(),
    /** File path where the task is defined */
    filePath: z.string(),
    /** Name of the exported task function */
    exportName: z.string(),
    /** Version of the task */
    version: z.string(),
    /** Version of the SDK used */
    sdkVersion: z.string(),
    /** Version of the CLI used */
    cliVersion: z.string(),
  }),
  /** Run information */
  run: z.object({
    /** Unique identifier for the run */
    id: z.string(),
    /** Run number */
    number: z.number(),
    /** Current status of the run */
    status: RunStatus,
    /** When the run was created */
    createdAt: z.coerce.date(),
    /** When the run started executing */
    startedAt: z.coerce.date().optional(),
    /** When the run finished executing */
    completedAt: z.coerce.date().optional(),
    /** Whether this is a test run */
    isTest: z.boolean(),
    /** Idempotency key for the run */
    idempotencyKey: z.string(),
    /** Associated tags */
    tags: z.array(z.string()),
    /** Error information */
    error: TaskRunError,
    /** Whether the run was an out-of-memory error */
    isOutOfMemoryError: z.boolean(),
    /** Machine preset used for the run */
    machine: z.string(),
    /** URL to view the run in the dashboard */
    dashboardUrl: z.string(),
  }),
  /** Environment information */
  environment: z.object({
    /** Environment ID */
    id: z.string(),
    /** Environment type */
    type: RuntimeEnvironmentTypeSchema,
    /** Environment slug */
    slug: z.string(),
  }),
  /** Organization information */
  organization: z.object({
    /** Organization ID */
    id: z.string(),
    /** Organization slug */
    slug: z.string(),
    /** Organization name */
    name: z.string(),
  }),
  /** Project information */
  project: z.object({
    /** Project ID */
    id: z.string(),
    /** Project reference */
    ref: z.string(),
    /** Project slug */
    slug: z.string(),
    /** Project name */
    name: z.string(),
  }),
});
export type AlertWebhookRunFailedObject = z.infer<typeof AlertWebhookRunFailedObject>;

/** Represents a deployment error */
export const DeployError = z.object({
  /** Error name */
  name: z.string(),
  /** Error message */
  message: z.string(),
  /** Error stack trace */
  stack: z.string().optional(),
  /** Standard error output */
  stderr: z.string().optional(),
});
export type DeployError = z.infer<typeof DeployError>;

/** Represents a deployment alert webhook payload */
export const AlertWebhookDeploymentObject = z.discriminatedUnion("success", [
  /** Successful deployment */
  z.object({
    success: z.literal(true),
    deployment: z.object({
      /** Deployment ID */
      id: z.string(),
      /** Deployment status */
      status: z.string(),
      /** Deployment version */
      version: z.string(),
      /** Short code identifier */
      shortCode: z.string(),
      /** When the deployment completed */
      deployedAt: z.coerce.date(),
    }),
    /** Deployed tasks */
    tasks: z.array(
      z.object({
        /** Task ID */
        id: z.string(),
        /** File path where the task is defined */
        filePath: z.string(),
        /** Name of the exported task function */
        exportName: z.string(),
        /** Source of the trigger */
        triggerSource: z.string(),
      })
    ),
    /** Environment information */
    environment: z.object({
      id: z.string(),
      type: RuntimeEnvironmentTypeSchema,
      slug: z.string(),
    }),
    /** Organization information */
    organization: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
    /** Project information */
    project: z.object({
      id: z.string(),
      ref: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
  }),
  /** Failed deployment */
  z.object({
    success: z.literal(false),
    deployment: z.object({
      /** Deployment ID */
      id: z.string(),
      /** Deployment status */
      status: z.string(),
      /** Deployment version */
      version: z.string(),
      /** Short code identifier */
      shortCode: z.string(),
      /** When the deployment failed */
      failedAt: z.coerce.date(),
    }),
    /** Environment information */
    environment: z.object({
      id: z.string(),
      type: RuntimeEnvironmentTypeSchema,
      slug: z.string(),
    }),
    /** Organization information */
    organization: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
    /** Project information */
    project: z.object({
      id: z.string(),
      ref: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
    /** Error information */
    error: DeployError,
  }),
]);

export type AlertWebhookDeploymentObject = z.infer<typeof AlertWebhookDeploymentObject>;

/** Common properties for all webhooks */
const commonProperties = {
  /** Webhook ID */
  id: z.string(),
  /** When the webhook was created */
  created: z.coerce.date(),
  /** Version of the webhook */
  webhookVersion: z.string(),
};

/** Represents all possible webhook types */
export const Webhook = z.discriminatedUnion("type", [
  /** Run failed alert webhook */
  z.object({
    ...commonProperties,
    type: z.literal("alert.run.failed"),
    object: AlertWebhookRunFailedObject,
  }),
  /** Deployment finished alert webhook */
  z.object({
    ...commonProperties,
    type: z.literal("alert.deployment.finished"),
    object: AlertWebhookDeploymentObject,
  }),
]);

export type Webhook = z.infer<typeof Webhook>;
