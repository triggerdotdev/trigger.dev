import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";
import { getSchemaParseFn } from "./schemas.js";
import { convertToolParametersToSchema } from "./tools.js";

describe("AI tool parameter schemas", () => {
  it("uses the caller's validator and preserves validation failures", async () => {
    const parameters = jsonSchema<{ count: number }>(
      { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
      {
        validate(value) {
          if (
            typeof value === "object" &&
            value !== null &&
            "count" in value &&
            typeof value.count === "number"
          ) {
            return { success: true, value: { count: value.count } };
          }
          return { success: false, error: new Error("count must be a number") };
        },
      }
    );
    const parse = getSchemaParseFn(convertToolParametersToSchema(parameters));

    await expect(parse({ count: 3 })).resolves.toEqual({ count: 3 });
    await expect(parse({ count: "invalid" })).rejects.toThrow("count must be a number");
  });
});
