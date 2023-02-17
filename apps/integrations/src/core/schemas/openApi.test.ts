import { expect, test } from "vitest";
import spec from "./test-openapi-spec-v2.json";
import { dereferenceSpec, schemaFromOpenApiSpecV2 } from "./openApi";

test("Returns the correct schema", async () => {
  const dereferenced = dereferenceSpec(spec);
  const schema = schemaFromOpenApiSpecV2(
    dereferenced,
    "/paths//conversations.list/get/responses/200/schema"
  );
  expect(schema.type).toEqual("object");
  expect(schema.additionalProperties).toEqual(false);
});
