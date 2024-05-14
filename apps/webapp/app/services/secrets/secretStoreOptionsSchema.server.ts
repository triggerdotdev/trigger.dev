import { z } from "zod";

export const SecretStoreOptionsSchema = z.enum(["DATABASE", "AWS_PARAM_STORE"]);
export type SecretStoreOptions = z.infer<typeof SecretStoreOptionsSchema>;
