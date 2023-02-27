import { describe, expect, test } from "vitest";
import { AutoReffer } from "./autoReffer";
import { JSONSchema } from "./types";

describe("autoReffer", async () => {
  test("simple", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        type: {
          type: "string",
          const: "person",
        },
        person: {
          title: "Person",
          type: "object",
          properties: {
            email: {
              type: "string",
            },
          },
          additionalProperties: false,
        },
        parent: {
          title: "Person",
          type: "object",
          properties: {
            email: {
              type: "string",
            },
          },
          additionalProperties: false,
        },
        id: {
          type: "string",
        },
      },
      required: ["type", "person", "id"],
      additionalProperties: false,
    };

    const autoReffer = new AutoReffer(schema);
    const optimizedSchema = autoReffer.optimize();

    expect(optimizedSchema).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "definitions": {
          "Person": {
            "additionalProperties": false,
            "properties": {
              "email": {
                "type": "string",
              },
            },
            "title": "Person",
            "type": "object",
          },
        },
        "properties": {
          "id": {
            "type": "string",
          },
          "parent": {
            "$ref": "#/definitions/Person",
          },
          "person": {
            "$ref": "#/definitions/Person",
          },
          "type": {
            "const": "person",
            "type": "string",
          },
        },
        "required": [
          "type",
          "person",
          "id",
        ],
        "type": "object",
      }
    `);
  });
});
