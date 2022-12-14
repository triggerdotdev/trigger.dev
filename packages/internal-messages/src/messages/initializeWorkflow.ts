import { z } from "zod";
import { MessageCatalogSchema } from "../messageCatalogSchema";
import { WorkflowEventPropertiesSchema } from "../sharedSchemas";

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

const Catalog = {
  INITIALIZE_WORKFLOW: {
    data: WorkflowMetadataSchema,
    properties: WorkflowEventPropertiesSchema,
  },
};

export default Catalog;
