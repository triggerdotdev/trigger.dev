import {
  makeObjectSchema,
  makeStringSchema,
  makeUnion,
} from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";

export const CollaboratorSchema = makeObjectSchema("A Collaborator", {
  requiredProperties: {
    id: makeStringSchema("Collaborator ID"),
    email: makeStringSchema("Collaborator Email"),
    name: makeStringSchema("Collaborator Name"),
  },
});

export const ThumbnailSchema = makeObjectSchema("A Thumbnail", {
  requiredProperties: {
    url: makeStringSchema("Thumbnail URL"),
    width: makeStringSchema("Thumbnail Width"),
    height: makeStringSchema("Thumbnail Height"),
  },
});

export const AttachmentSchema = makeObjectSchema("An Attachment", {
  requiredProperties: {
    id: makeStringSchema("Attachment ID"),
    url: makeStringSchema("Attachment URL"),
    filename: makeStringSchema("Attachment Filename"),
    size: makeStringSchema("Attachment Size"),
    type: makeStringSchema("Attachment Type"),
  },
  optionalProperties: {
    thumbnails: ThumbnailSchema,
  },
});

export const FieldSchema: JSONSchema = {
  title: "Field",
  type: "object",
  oneOf: [
    {
      type: "string",
    },
    {
      type: "number",
    },
    {
      type: "boolean",
    },
    CollaboratorSchema,
  ],
};
