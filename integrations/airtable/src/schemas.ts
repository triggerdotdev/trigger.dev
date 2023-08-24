import { z } from "zod";

const UserSourceMetadata = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    permissionLevel: z.union([
      z.literal("none"),
      z.literal("read"),
      z.literal("comment"),
      z.literal("edit"),
      z.literal("create"),
    ]),
    name: z.string().optional(),
    profilePicUrl: z.string().optional(),
  }),
});

const WebhookAction = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("client"),
    sourceMetadata: UserSourceMetadata,
  }),
  z.object({
    source: z.literal("publicApi"),
    sourceMetadata: UserSourceMetadata,
  }),
  z.object({
    source: z.literal("formSubmission"),
    sourceMetadata: z.object({
      viewId: z.string(),
    }),
  }),
  z.object({
    source: z.literal("automation"),
    sourceMetadata: z.object({
      automationId: z.string(),
    }),
  }),
  z.object({
    source: z.literal("system"),
  }),
  z.object({
    source: z.literal("sync"),
  }),
  z.object({
    source: z.literal("anonymousUser"),
  }),
  z.object({
    source: z.literal("unknown"),
  }),
]);

const CreatedFieldSchema = z.object({
  name: z.string(),
  type: z.union([
    z.literal("singleLineText"),
    z.literal("email"),
    z.literal("url"),
    z.literal("multilineText"),
    z.literal("number"),
    z.literal("percent"),
    z.literal("currency"),
    z.literal("singleSelect"),
    z.literal("multipleSelects"),
    z.literal("singleCollaborator"),
    z.literal("multipleCollaborators"),
    z.literal("multipleRecordLinks"),
    z.literal("date"),
    z.literal("dateTime"),
    z.literal("phoneNumber"),
    z.literal("multipleAttachments"),
    z.literal("checkbox"),
    z.literal("formula"),
    z.literal("createdTime"),
    z.literal("rollup"),
    z.literal("count"),
    z.literal("lookup"),
    z.literal("multipleLookupValues"),
    z.literal("autoNumber"),
    z.literal("barcode"),
    z.literal("rating"),
    z.literal("richText"),
    z.literal("duration"),
    z.literal("lastModifiedTime"),
    z.literal("button"),
    z.literal("createdBy"),
    z.literal("lastModifiedBy"),
    z.literal("externalSyncSource"),
    z.literal("aiText"),
    z.string(),
  ]),
});

const ChangedRecordFieldSchema = z.object({
  cellValuesByFieldId: z.record(z.any()),
});

const CreatedRecordSchema = ChangedRecordFieldSchema.and(
  z.object({
    createdTime: z.string(),
  })
);

const ChangedRecordSchema = z.object({
  current: ChangedRecordFieldSchema,
  previous: ChangedRecordFieldSchema.optional(),
  unchanged: ChangedRecordFieldSchema.optional(),
});

const ChangedTableMetadata = z.object({
  name: z.string().optional(),
  description: z.string().nullish(),
});

const ChangedTableSchema = z.object({
  changedViewsById: z
    .record(
      z.object({
        changedRecordsById: z.record(ChangedRecordSchema).optional(),
        createdRecordsById: z.record(CreatedRecordSchema).optional(),
        destroyedRecordIds: z.array(z.string()).optional(),
      })
    )
    .optional(),
  changedFieldsById: z
    .record(
      z.object({
        current: CreatedFieldSchema.partial(),
        previous: CreatedFieldSchema.partial().optional(),
      })
    )
    .optional(),
  changedRecordsById: z.record(ChangedRecordSchema).optional(),
  createdFieldsById: z.record(CreatedFieldSchema).optional(),
  createdRecordsById: z.record(CreatedRecordSchema).optional(),
  changedMetadata: z
    .object({
      current: ChangedTableMetadata,
      previous: ChangedTableMetadata.optional(),
    })
    .optional(),
  destroyedFieldIds: z.array(z.string()).optional(),
  destroyedRecordIds: z.array(z.string()).optional(),
});

const CreatedTableSchema = z.object({
  metadata: z
    .object({
      name: z.string(),
      description: z.string().optional(),
    })
    .optional(),
  fieldsById: z.record(CreatedFieldSchema).optional(),
  recordsById: z.record(CreatedRecordSchema).optional(),
});

export const WebhookPayloadSchema = z.object({
  timestamp: z.coerce.date(),
  baseTransactionNumber: z.number(),
  payloadFormat: z.literal("v0"),
  actionMetadata: WebhookAction,
  changedTablesById: z.record(ChangedTableSchema).optional(),
  createdTablesById: z.record(CreatedTableSchema).optional(),
  destroyedTableIds: z.array(z.string()).optional(),
});

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

export const ListWebhooksResponseSchema = z.object({
  cursor: z.number(),
  mightHaveMore: z.boolean(),
  payloads: z.array(WebhookPayloadSchema),
});

export type ListWebhooksResponse = z.infer<typeof ListWebhooksResponseSchema>;
