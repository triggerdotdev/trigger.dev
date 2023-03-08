import { validate } from "core/schemas/validate";
import { describe, expect, test } from "vitest";
import { makeRefInSchema } from "./makeSchema";

describe("validate", async () => {
  test("string ref", async () => {
    const schema = makeRefInSchema("#/components/basic", {
      components: {
        basic: {
          type: "number",
        },
      },
    });

    const validationResult = await validate(123, schema);
    expect(validationResult).toEqual({
      success: true,
    });
  });

  test("deep ref", async () => {
    const schema = makeRefInSchema("#/components/basic", {
      components: {
        basic: {
          type: "object",
          properties: {
            something: {
              $ref: "#/components/something",
            },
          },
          required: ["something"],
        },
        something: {
          type: "number",
        },
      },
    });

    const validationResult = await validate(
      {
        something: 2,
      },
      schema
    );
    expect(validationResult).toEqual({
      success: true,
    });
  });
});
