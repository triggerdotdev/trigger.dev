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
