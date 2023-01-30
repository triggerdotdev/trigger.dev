import { z } from "zod";
import {
  repositorySchema,
  userSchema,
  installationLiteSchema,
  organizationSchema,
  commitSchema,
  committerSchema,
} from "./shared";

export const pushEventSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  created: z.boolean(),
  deleted: z.boolean(),
  forced: z.boolean(),
  base_ref: z.string().nullable(),
  compare: z.string(),
  commits: z.array(commitSchema),
  head_commit: commitSchema.nullable(),
  repository: repositorySchema,
  pusher: committerSchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});
