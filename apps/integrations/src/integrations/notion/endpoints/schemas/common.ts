import { EndpointSpecParameter } from "core/endpoint/types";
import { makeStringSchema, makeObjectSchema } from "core/schemas/makeSchema";

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

// type IdRequest = string | string
export const IdRequest = makeStringSchema("IdRequest", "IdRequest");

// type EmptyObject = Record<string, never>
export const EmptyObject = makeObjectSchema("EmptyObject", {});

// type StringRequest = string
export const StringRequest = makeStringSchema("StringRequest", "StringRequest");
