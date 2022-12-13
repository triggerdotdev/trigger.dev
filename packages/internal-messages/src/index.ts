import { z } from "zod";

export const TriggerMetadataSchema = z.object({
  id: z.string(),
});

export const PackageMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export const WorkflowMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: TriggerMetadataSchema,
  package: PackageMetadataSchema,
});

export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;

export const MetadataMessageCatalog = {
  INITIALIZE_WORKFLOW: {
    data: WorkflowMetadataSchema,
  },
};

export type MetadataMessages = typeof MetadataMessageCatalog;

export type MessageCatalogSchema = {
  [key: string]: {
    data: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any, any>;
  };
};

export const RetryOptionsSchema = z.object({
  retries: z.number().default(10),
  factor: z.number().default(2),
  minTimeout: z.number().default(1 * 1000),
  maxTimeout: z.number().default(60 * 1000),
  randomize: z.boolean().default(true),
});

export type RetryOptions = z.infer<typeof RetryOptionsSchema>;

export const IntegrationRequestOptionsSchema = z
  .object({
    retry: RetryOptionsSchema.optional(),
  })
  .optional();

export type IntegrationRequestOptions = z.infer<
  typeof IntegrationRequestOptionsSchema
>;

export const IntegrationRequestInfoSchema = z.object({
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
  headers: z.record(z.string()),
  body: z.any(),
  metadata: z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
    })
    .optional(),
});

export type IntegrationRequestInfo = z.infer<
  typeof IntegrationRequestInfoSchema
>;

export const InitiateIntegrationRequestSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  requestInfo: IntegrationRequestInfoSchema,
  options: z
    .object({
      retry: RetryOptionsSchema.optional(),
    })
    .optional(),
});

export type InitiateIntegrationRequest = z.infer<
  typeof InitiateIntegrationRequestSchema
>;
