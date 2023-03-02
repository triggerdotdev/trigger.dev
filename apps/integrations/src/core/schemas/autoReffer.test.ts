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
            timezone: {
              type: "string",
              enum: [
                "Africa/Abidjan",
                "Africa/Accra",
                "Africa/Addis_Ababa",
                "Africa/Algiers",
                "Africa/Asmara",
                "Africa/Asmera",
              ],
            },
            props: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    first: {
                      type: "string",
                    },
                    last: {
                      type: "string",
                    },
                  },
                },
              ],
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
            timezone: {
              type: "string",
              enum: [
                "Africa/Abidjan",
                "Africa/Accra",
                "Africa/Addis_Ababa",
                "Africa/Algiers",
                "Africa/Asmara",
                "Africa/Asmera",
              ],
            },
            props: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    first: {
                      type: "string",
                    },
                    last: {
                      type: "string",
                    },
                  },
                },
              ],
            },
          },
          additionalProperties: false,
        },
        id: {
          type: "string",
        },
        tz: {
          type: "string",
          enum: [
            "Africa/Abidjan",
            "Africa/Accra",
            "Africa/Addis_Ababa",
            "Africa/Algiers",
            "Africa/Asmara",
            "Africa/Asmera",
          ],
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
              "props": {
                "anyOf": [
                  {
                    "$ref": "#/definitions/Props",
                  },
                ],
              },
              "timezone": {
                "$ref": "#/definitions/Timezone",
              },
            },
            "title": "Person",
            "type": "object",
          },
          "Props": {
            "properties": {
              "first": {
                "type": "string",
              },
              "last": {
                "type": "string",
              },
            },
            "type": "object",
          },
          "Timezone": {
            "enum": [
              "Africa/Abidjan",
              "Africa/Accra",
              "Africa/Addis_Ababa",
              "Africa/Algiers",
              "Africa/Asmara",
              "Africa/Asmera",
            ],
            "type": "string",
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
          "tz": {
            "$ref": "#/definitions/Timezone",
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
