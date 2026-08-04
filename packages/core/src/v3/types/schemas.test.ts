import { describe, expect, expectTypeOf, it } from "vitest";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";
import { getSchemaParseFn, isSchemaZodEsque } from "./schemas.js";
import {
  convertToolParametersToSchema,
  type inferToolParameters,
} from "./tools.js";

describe("Zod schema compatibility", () => {
  it("detects and parses Zod 3 schemas", async () => {
    const schema = z3.object({ name: z3.string() });

    expect(isSchemaZodEsque(schema)).toBe(true);
    expect(convertToolParametersToSchema(schema)).toBe(schema);
    await expect(getSchemaParseFn(schema)({ name: "Trigger.dev" })).resolves.toEqual({
      name: "Trigger.dev",
    });

    expectTypeOf<inferToolParameters<typeof schema>>().toEqualTypeOf<{ name: string }>();
  });

  it("detects and parses Zod 4 schemas", async () => {
    const schema = z4.object({ name: z4.string() });

    expect(isSchemaZodEsque(schema)).toBe(true);
    expect(convertToolParametersToSchema(schema)).toBe(schema);
    await expect(getSchemaParseFn(schema)({ name: "Trigger.dev" })).resolves.toEqual({
      name: "Trigger.dev",
    });

    expectTypeOf<inferToolParameters<typeof schema>>().toEqualTypeOf<{ name: string }>();
  });

  it("does not identify non-schemas as Zod schemas", () => {
    expect(isSchemaZodEsque(null)).toBe(false);
    expect(isSchemaZodEsque({})).toBe(false);
  });
});
