import { z } from "zod";
import { MachinePresetName, TaskRunError } from "./common.js";
import { RunStatus } from "./api.js";
import { RuntimeEnvironmentTypeSchema } from "../../schemas/api.js";

const AlertWebhookRunFailedObject = z.object({
  task: z.object({
    id: z.string(),
    filePath: z.string(),
    exportName: z.string(),
    version: z.string(),
    sdkVersion: z.string(),
    cliVersion: z.string(),
  }),
  run: z.object({
    id: z.string(),
    number: z.number(),
    status: RunStatus,
    createdAt: z.coerce.date(),
    startedAt: z.coerce.date().optional(),
    completedAt: z.coerce.date().optional(),
    isTest: z.boolean(),
    idempotencyKey: z.string(),
    tags: z.array(z.string()),
    error: TaskRunError,
    machine: MachinePresetName,
    dashboardUrl: z.string(),
  }),
  environment: z.object({
    id: z.string(),
    type: RuntimeEnvironmentTypeSchema,
    slug: z.string(),
  }),
  organization: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
  project: z.object({
    id: z.string(),
    ref: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
});
export type AlertWebhookRunFailedObject = z.infer<typeof AlertWebhookRunFailedObject>;

export const DeployError = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  stderr: z.string().optional(),
});
export type DeployError = z.infer<typeof DeployError>;

export const AlertWebhookDeploymentObject = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    deployment: z.object({
      id: z.string(),
      status: z.string(),
      version: z.string(),
      shortCode: z.string(),
      deployedAt: z.coerce.date(),
    }),
    tasks: z.array(
      z.object({
        id: z.string(),
        filePath: z.string(),
        exportName: z.string(),
        triggerSource: z.string(),
      })
    ),
    environment: z.object({
      id: z.string(),
      type: RuntimeEnvironmentTypeSchema,
      slug: z.string(),
    }),
    organization: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
    project: z.object({
      id: z.string(),
      ref: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
  }),
  z.object({
    success: z.literal(false),
    deployment: z.object({
      id: z.string(),
      status: z.string(),
      version: z.string(),
      shortCode: z.string(),
      failedAt: z.coerce.date(),
    }),
    environment: z.object({
      id: z.string(),
      type: RuntimeEnvironmentTypeSchema,
      slug: z.string(),
    }),
    organization: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
    project: z.object({
      id: z.string(),
      ref: z.string(),
      slug: z.string(),
      name: z.string(),
    }),
    error: DeployError,
  }),
]);

export type AlertWebhookDeploymentObject = z.infer<typeof AlertWebhookDeploymentObject>;

const commonProperties = {
  id: z.string(),
  created: z.coerce.date(),
  webhookVersion: z.string(),
};

export const Webhook = z.discriminatedUnion("type", [
  z.object({
    ...commonProperties,
    type: z.literal("alert.run.failed"),
    object: AlertWebhookRunFailedObject,
  }),
  z.object({
    ...commonProperties,
    type: z.literal("alert.deployment.finished"),
    object: AlertWebhookDeploymentObject,
  }),
]);

export type Webhook = z.infer<typeof Webhook>;
