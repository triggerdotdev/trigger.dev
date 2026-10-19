import { z } from "zod";

const SecretStoreOptionsSchema = z.enum(["DATABASE", "AWS_KMS", "AWS_PARAM_STORE"]);
export type SecretStoreOptions = z.infer<typeof SecretStoreOptionsSchema>;
