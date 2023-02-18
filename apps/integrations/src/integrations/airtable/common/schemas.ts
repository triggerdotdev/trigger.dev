import {
  makeArraySchema,
  makeBooleanSchema,
  makeNumberSchema,
  makeObjectSchema,
  makeStringSchema,
  makeOneOf,
  makeAnyOf,
} from "core/schemas/makeSchema";

export const CollaboratorSchema = makeObjectSchema("A Collaborator", {
  requiredProperties: {
    id: makeStringSchema("Collaborator ID"),
    email: makeStringSchema("Collaborator Email"),
    name: makeStringSchema("Collaborator Name"),
  },
  additionalProperties: true,
});

export const ThumbnailSchema = makeObjectSchema("A Thumbnail", {
  requiredProperties: {
    url: makeStringSchema("Thumbnail URL"),
    width: makeNumberSchema("Thumbnail Width"),
    height: makeNumberSchema("Thumbnail Height"),
  },
  additionalProperties: true,
});

export const AttachmentSchema = makeObjectSchema("An Attachment", {
  requiredProperties: {
    id: makeStringSchema("Attachment ID"),
    url: makeStringSchema("Attachment URL"),
    filename: makeStringSchema("Attachment Filename"),
    size: makeNumberSchema("Attachment Size"),
    type: makeStringSchema("Attachment Type"),
  },
  optionalProperties: {
    height: makeNumberSchema("Attachment Height"),
    width: makeNumberSchema("Attachment Width"),
    thumbnails: makeObjectSchema("Thumbnails", {
      requiredProperties: {
        small: ThumbnailSchema,
        large: ThumbnailSchema,
        full: ThumbnailSchema,
      },
      additionalProperties: true,
    }),
  },
  additionalProperties: true,
});

export const FieldSchema = makeOneOf("A Field", [
  makeStringSchema(),
  makeNumberSchema(),
  makeBooleanSchema(),
  CollaboratorSchema,
  makeArraySchema("Collaborators", CollaboratorSchema),
  makeArraySchema("Values", makeStringSchema()),
  makeArraySchema("Attachments", AttachmentSchema),
]);
