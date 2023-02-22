import { EndpointSpecParameter } from "core/endpoint/types";
import {
  makeArraySchema,
  makeBooleanSchema,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";

export const VersionHeaderParam: EndpointSpecParameter = {
  name: "Notion-Version",
  in: "header",
  description:
    "The Notion API is versioned. Our API versions are named for the date the version is released, for example, 2022-06-28",
  schema: {
    type: "string",
  },
  required: true,
};
