import deref from "json-schema-deref-sync";
import pointer from "json-pointer";
import { type JSONSchema } from "./types";

export function dereferenceSpec(spec: any): any {
  return deref(spec);
}

// todo validate that it's a valid json schema
export function schemaFromOpenApiSpecV2(spec: any, path: string): JSONSchema {
  // we need to escape the path because it contains ~ and / characters
  path = path.replace(/~/g, "~0").replace(/\/\//g, "/~1");
  const schema = pointer.get(spec as pointer.JsonObject, path);
  return schema;
}
