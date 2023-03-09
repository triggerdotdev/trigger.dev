import { describe, expect, test } from "vitest";
import { schemaFromRef } from "./makeSchema";
import { promises as fs } from "fs";
import { checkoutSessionEventSchema } from "integrations/stripe/webhooks/events/checkoutSession";

describe("make schema", async () => {
  test("schemaFromRef", async () => {
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

    const flatSchema = schemaFromRef("#/components/basic", schema);
    expect(flatSchema).toMatchInlineSnapshot(`
      {
        "components": {
          "another": {
            "type": "number",
          },
          "something": {
            "properties": {
              "another": {
                "$ref": "#/components/another",
              },
            },
            "type": "object",
          },
        },
        "properties": {
          "something": {
            "$ref": "#/components/something",
            "description": "Something",
          },
        },
        "required": [
          "something",
        ],
        "type": "object",
      }
    `);
  });

  test("schemaFromRef", async () => {
    const schema = checkoutSessionEventSchema;
    await fs.writeFile(
      "/Users/Matt/Downloads/schemaFromRef.json",
      JSON.stringify(schema, null, 2)
    );
    expect(true).toBe(true);
  });
});
