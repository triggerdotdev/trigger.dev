import { validate } from "core/schemas/validate";
import { describe, expect, test } from "vitest";
import { makeRefInSchema } from "./makeSchema";
import { transformNullables } from "./transformNullables";

describe("transform nullables", async () => {
  test("example", async () => {
    const original = {
      components: {
        schemas: {
          account: {
            description: "Description",
            properties: {
              business_profile: {
                anyOf: [
                  {
                    $ref: "#/components/schemas/account_business_profile",
                  },
                ],
                description: "Business information about the account.",
                nullable: true,
              },
              business_type: {
                description: "The business type.",
                enum: ["company", "government_entity"],
                nullable: true,
                type: "string",
                "x-stripeBypassValidation": true,
              },
            },
          },
        },
      },
    };

    transformNullables(original);
    expect(original).toMatchInlineSnapshot(`
      {
        "components": {
          "schemas": {
            "account": {
              "description": "Description",
              "properties": {
                "business_profile": {
                  "anyOf": [
                    {
                      "$ref": "#/components/schemas/account_business_profile",
                    },
                    {
                      "type": "null",
                    },
                  ],
                  "description": "Business information about the account.",
                },
                "business_type": {
                  "description": "The business type.",
                  "enum": [
                    "company",
                    "government_entity",
                    null,
                  ],
                  "type": [
                    "string",
                    "null",
                  ],
                  "x-stripeBypassValidation": true,
                },
              },
            },
          },
        },
      }
    `);
  });
});
