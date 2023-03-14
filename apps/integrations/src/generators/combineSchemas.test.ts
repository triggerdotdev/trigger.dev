import { JSONSchema } from "core/schemas/types";
import { describe, expect, test } from "vitest";
import { createMinimalSchema } from "./combineSchemas";

describe("combine schemas", async () => {
  test("create minimal schema", async () => {
    const definitions: Record<string, JSONSchema> = {
      basic: {
        type: "object",
        properties: {
          something: {
            $ref: "#/definitions/something",
            description: "Something",
          },
        },
        required: ["something"],
      },
      something: {
        type: "object",
        properties: {
          another: {
            $ref: "#/definitions/another",
          },
        },
      },
      another: {
        type: "number",
      },
      extra: {
        title: "Extra",
        type: "string",
      },
    };

    const minimalSchema = createMinimalSchema(
      "#/definitions/basic",
      definitions
    );

    expect(minimalSchema).toMatchInlineSnapshot(`
      {
        "definitions": {
          "another": {
            "type": "number",
          },
          "something": {
            "properties": {
              "another": {
                "$ref": "#/definitions/another",
              },
            },
            "type": "object",
          },
        },
        "properties": {
          "something": {
            "$ref": "#/definitions/something",
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
});
