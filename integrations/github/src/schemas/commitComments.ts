import { z } from "zod";
import {
  userSchema,
  authorAssociationSchema,
  repositorySchema,
  installationLiteSchema,
  organizationSchema,
} from "./shared";

export const commitCommentEventSchema = z.object({
  action: z.literal("created"),
  comment: z.object({
    url: z.string(),
    html_url: z.string(),
    id: z.number(),
    node_id: z.string(),
    user: userSchema,
    position: z.number().nullable(),
    line: z.number().nullable(),
    path: z.string().nullable(),
    commit_id: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    author_association: authorAssociationSchema,
    body: z.string(),
  }),
  repository: repositorySchema,
  sender: userSchema,
  installation: installationLiteSchema.optional(),
  organization: organizationSchema.optional(),
});
