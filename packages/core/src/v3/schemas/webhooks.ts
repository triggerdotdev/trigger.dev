import { z } from "zod";
import { RunStatus } from "./api.js";
import { RuntimeEnvironmentTypeSchema, TaskRunError } from "./common.js";

const ID_PATTERNS = {
  RUN: /^run_[a-zA-Z0-9]+$/,
  TASK: /^task_[a-zA-Z0-9]+$/,
  ENV: /^env_[a-zA-Z0-9]+$/,
  ORG: /^org_[a-zA-Z0-9]+$/,
  PROJECT: /^proj_[a-zA-Z0-9]+$/,
};

const idWithPrefix = (pattern: RegExp) => z.string().regex(pattern, "Invalid ID format");

export const AlertWebhookRunFailedObject = z.object({
  task: z.object({
    id: idWithPrefix(ID_PATTERNS.TASK),
    filePath: z.string().min(1),
    exportName: z.string().optional(),
    version: z.string(),
    sdkVersion: z.string(),
    cliVersion: z.string(),
  }),
  run: z.object({
    id: idWithPrefix(ID_PATTERNS.RUN),
    number: z.number().int().positive(),
    status: RunStatus,
    createdAt: z.coerce.date(),
    startedAt: z.coerce.date().optional(),
    completedAt: z.coerce.date().optional(),
    isTest: z.boolean(),
    idempotencyKey: z.string().optional(),
    tags: z.array(z.string().max(50)).max(20),
    error: TaskRunError,
    isOutOfMemoryError: z.boolean(),
    machine: z.string(),
    dashboardUrl: z.string().url(),
  }),
  environment: z.object({
    id: idWithPrefix(ID_PATTERNS.ENV),
    type: RuntimeEnvironmentTypeSchema,
    slug: z.string(),
  }),
  organization: z.object({
    id: idWithPrefix(ID_PATTERNS.ORG),
    slug: z.string(),
    name: z.string(),
  }),
  project: z.object({
    id: idWithPrefix(ID_PATTERNS.PROJECT),
    ref: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
});
