import { describe, expect, test } from "vitest";
import { schemaFromRef } from "./deReffer";
import { makeRefInSchema } from "./makeSchema";

describe("deref", async () => {
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

    const dereffed = schemaFromRef(schema);

    expect(dereffed).toMatchInlineSnapshot("undefined");
  });
});
