import { z } from "zod";
import { organizationSchema, repositorySchema, userSchema } from "./shared";

export const starCreatedEventSchema = z.object({
  action: z.literal("created"),
  starred_at: z.coerce.date(),
  repository: repositorySchema,
  sender: userSchema,
  organization: organizationSchema.optional(),
});

export const starDeletedEventSchema = z.object({
  action: z.literal("deleted"),
  repository: repositorySchema,
  sender: userSchema,
  organization: organizationSchema.optional(),
});

export const starEventSchema = z.discriminatedUnion("action", [
  starCreatedEventSchema,
  starDeletedEventSchema,
]);
