import { compile } from "json-schema-to-typescript";

export async function getTypesFromSchema(schema: any, name: string) {
  const ts = await compile(schema, name, {
    additionalProperties: false,
    bannerComment: "",
  });
  return ts;
}
