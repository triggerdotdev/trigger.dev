import { z } from "zod";
import {
  WorkflowEventPropertiesSchema,
  RetryOptionsSchema,
} from "../sharedSchemas";

export const IntegrationRequestOptionsSchema = z
  .object({
    retry: RetryOptionsSchema.optional(),
  })
  .optional();

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

const Catalog = {
  INITIATE_INTEGRATION_REQUEST: {
    data: InitiateIntegrationRequestSchema,
    properties: WorkflowEventPropertiesSchema,
  },
};

export default Catalog;
