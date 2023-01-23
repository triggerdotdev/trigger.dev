import { z } from "zod";

export const WebhookSourceSchema = z.object({
  baseId: z.string(),
  scopes: z.array(z.string()),
  events: z.array(z.string()),
});

const fieldTypeSchema = z.union([
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
  z.string(),
]);

const userSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string(),
  profilePicUrl: z.string().optional(),
  permissionLevel: z.union([
    z.literal("none"),
    z.literal("read"),
    z.literal("comment"),
    z.literal("edit"),
    z.literal("create"),
  ]),
});

const actionMetadataSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("client"),
    sourceMetadata: z.object({
      user: userSchema,
    }),
  }),
  z.object({
    source: z.literal("publicApi"),
    sourceMetadata: z.object({
      user: userSchema,
    }),
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
]);

const thumbnailSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
});

const attachmentSchema = z.object({
  id: z.string(),
  url: z.string(),
  filename: z.string(),
  size: z.number(),
  type: z.string(),
  thumbnails: z
    .object({
      small: thumbnailSchema,
      large: thumbnailSchema,
      full: thumbnailSchema,
    })
    .optional(),
});

const collaboratorSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});

const cellValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(attachmentSchema),
  collaboratorSchema,
  z.array(collaboratorSchema),
  z.unknown(),
]);

const cellValueByFieldIdSchema = z.object({
  cellValuesByFieldId: z.record(cellValueSchema),
});

const currentPreviousUnchangedSchema = z.object({
  current: cellValueByFieldIdSchema,
  previous: cellValueByFieldIdSchema.optional(),
  unchanged: cellValueByFieldIdSchema.optional(),
});

export const payloadSchema = z.object({
  timestamp: z.string(),
  actionMetadata: actionMetadataSchema,
  baseTransactionNumber: z.number(),
  payloadFormat: z.literal("v0"),
  changedTablesById: z.record(
    z.object({
      createdRecordsById: z
        .record(
          z.object({
            createdTime: z.string(),
            cellValuesByFieldId: cellValueSchema,
          })
        )
        .optional(),
      changedRecordsById: z.record(currentPreviousUnchangedSchema).optional(),
      createdFieldsById: z
        .record(
          z.object({
            name: z.string(),
            type: z.string(),
          })
        )
        .optional(),
      changedFieldsById: z
        .record(
          z.object({
            current: z.object({
              type: fieldTypeSchema.optional(),
              name: z.string().optional(),
            }),
            previous: z
              .object({
                type: fieldTypeSchema.optional(),
                name: z.string().optional(),
              })
              .optional(),
          })
        )
        .optional(),
      changedMetadata: z
        .record(
          z.object({
            current: z.object({
              name: z.string().optional(),
              description: z.string().optional().nullable(),
            }),
            previous: z
              .object({
                name: z.string().optional(),
                description: z.string().optional().nullable(),
              })
              .optional(),
          })
        )
        .optional(),
      destroyedFieldIds: z.array(z.string()).optional(),
      destroyedRecordIds: z.array(z.string()).optional(),
      changedViewsById: z.record(
        z.object({
          createdRecordsById: z
            .record(
              z.object({
                cellValuesByFieldId: z.record(cellValueSchema),
                createdTime: z.string(),
              })
            )
            .optional(),
          changedRecordsById: z
            .record(currentPreviousUnchangedSchema)
            .optional(),
          destroyedRecordIds: z.array(z.string()).optional(),
        })
      ),
    })
  ),
});

export const WebhookPayloadListSchema = z.object({
  cursor: z.number(),
  mightHaveMore: z.boolean(),
  payloads: z.array(payloadSchema),
});

export const allEventSchema = z.object({
  base: z.object({
    id: z.string(),
  }),
  payloads: z.array(payloadSchema),
});
