import { describe, expect, test } from "vitest";
import { flatSchemaFromRef } from "./flatSchemaFromRef";

describe("flat schema", async () => {
  test("simple", async () => {
    const schema = {
      components: {
        basic: {
          type: "object",
          properties: {
            something: {
              $ref: "#/components/something",
              description: "Something",
            },
          },
          required: ["something"],
        },
        something: {
          type: "object",
          properties: {
            another: {
              $ref: "#/components/another",
            },
          },
        },
        another: {
          type: "number",
        },
      },
    };

    const flatSchema = flatSchemaFromRef(schema, "#/components/basic");
    expect(flatSchema).toMatchInlineSnapshot(`
      {
        "properties": {
          "something": {
            "description": "Something",
            "properties": {
              "another": {
                "type": "number",
              },
            },
            "type": "object",
          },
        },
        "required": [
          "something",
        ],
        "type": "object",
      }
    `);
  });
});
