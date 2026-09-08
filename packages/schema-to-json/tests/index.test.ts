import * as z3 from "zod/v3";
import * as z4 from "zod/v4";
import * as zFloor from "zod-v3-floor/v4";
import * as y from "yup";
// @ts-ignore
import { type } from "arktype";
import { Schema } from "effect";
import { Type } from "@sinclair/typebox";
import { schemaToJsonSchema, canConvertSchema } from "../src/index.js";

describe("schemaToJsonSchema", () => {
  describe("Zod schemas", () => {
    it("should convert a simple Zod object schema", () => {
      const schema = z3.object({
        name: z3.string(),
        age: z3.number(),
        email: z3.string().email(),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          email: { type: "string", format: "email" },
        },
        required: ["name", "age", "email"],
      });
    });

    it("should convert a simple Zod 4 object schema", () => {
      const schema = z4.object({
        name: z4.string(),
        age: z4.number(),
        email: z4.email(),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          email: { type: "string", format: "email" },
        },
        required: ["name", "age", "email"],
      });
    });

    it("should convert a Zod schema with optional fields", () => {
      const schema = z3.object({
        id: z3.string(),
        description: z3.string().optional(),
        tags: z3.array(z3.string()).optional(),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
      });
    });

    it("should handle Zod schema with name option", () => {
      const schema = z3.object({
        value: z3.number(),
      });

      const result = schemaToJsonSchema(schema, { useReferences: true });

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toBeDefined();
      // The exact structure depends on zod-to-json-schema implementation
    });
  });

  describe.each([
    { name: "minimum Zod 3 permalink", z: zFloor },
    { name: "current Zod 4", z: z4 },
  ])("$name", ({ z }) => {
    it("preserves optional union properties through wrappers", () => {
      const optionalUnion = z.union([z.string(), z.number().optional()]);
      const schema = z.object({
        required: z.string(),
        value: optionalUnion,
        nested: z.union([z.boolean(), optionalUnion]),
        readonly: optionalUnion.readonly(),
        nullable: optionalUnion.nullable(),
        lazy: z.lazy(() => optionalUnion),
        defaulted: optionalUnion.default("fallback"),
      });

      expect(schemaToJsonSchema(schema)?.jsonSchema.required).toEqual(["required", "defaulted"]);
    });

    it("rejects undefined union alternatives instead of treating them as null", () => {
      expect(() => schemaToJsonSchema(z.union([z.string(), z.undefined()]))).toThrow(
        "Undefined cannot be represented in JSON Schema"
      );
    });
  });

  it("preserves explicitly required metadata on current optional schemas", () => {
    const schema = z4.object({ value: z4.string().optional() }).meta({ required: ["value"] });
    expect(schemaToJsonSchema(schema)?.jsonSchema.required).toEqual(["value"]);
  });

  describe("Yup schemas", () => {
    it("should convert a simple Yup object schema", () => {
      const schema = y.object({
        name: y.string().required(),
        age: y.number().required(),
        email: y.string().email().required(),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          email: { type: "string", format: "email" },
        },
        required: ["name", "age", "email"],
      });
    });

    it("should convert a Yup schema with optional fields", () => {
      const schema = y.object({
        id: y.string().required(),
        description: y.string(),
        count: y.number().min(0).max(100),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          count: { type: "number", minimum: 0, maximum: 100 },
        },
        required: ["id"],
      });
    });
  });

  describe("ArkType schemas", () => {
    it("should convert a simple ArkType schema", () => {
      const schema = type({
        name: "string",
        age: "number",
        active: "boolean",
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toBeDefined();
      expect(result?.jsonSchema.type).toBe("object");
    });

    it("should convert an ArkType schema with optional fields", () => {
      const schema = type({
        id: "string",
        "description?": "string",
        "tags?": "string[]",
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toBeDefined();
      expect(result?.jsonSchema.type).toBe("object");
    });
  });

  describe("Effect schemas", () => {
    it("should convert a simple Effect schema", () => {
      const schema = Schema.Struct({
        name: Schema.String,
        age: Schema.Number,
        active: Schema.Boolean,
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          active: { type: "boolean" },
        },
        required: ["name", "age", "active"],
      });
    });

    it("should convert an Effect schema with optional fields", () => {
      const schema = Schema.Struct({
        id: Schema.String,
        description: Schema.optional(Schema.String),
        count: Schema.optional(Schema.Number),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toBeDefined();
      expect(result?.jsonSchema.type).toBe("object");
    });
  });

  describe("TypeBox schemas", () => {
    it("should convert a simple TypeBox schema", () => {
      const schema = Type.Object({
        name: Type.String(),
        age: Type.Number(),
        active: Type.Boolean(),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          active: { type: "boolean" },
        },
        required: ["name", "age", "active"],
      });
    });

    it("should convert a TypeBox schema with optional fields", () => {
      const schema = Type.Object({
        id: Type.String(),
        description: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
      });
    });
  });

  describe("Unsupported schemas", () => {
    it("should return undefined for unsupported schema types", () => {
      const invalidSchema = { notASchema: true };
      const result = schemaToJsonSchema(invalidSchema);
      expect(result).toBeUndefined();
    });

    it("should return undefined for plain functions", () => {
      const fn = (value: unknown) => typeof value === "string";
      const result = schemaToJsonSchema(fn);
      expect(result).toBeUndefined();
    });
  });
});

describe("canConvertSchema", () => {
  it("should return true for supported schemas", () => {
    expect(canConvertSchema(z3.string())).toBe(true);
    expect(canConvertSchema(y.string())).toBe(true);
    expect(canConvertSchema(type("string"))).toBe(true);
    expect(canConvertSchema(Schema.String)).toBe(true);
    expect(canConvertSchema(Type.String())).toBe(true);
  });

  it("should return false for unsupported schemas", () => {
    expect(canConvertSchema(null)).toBe(false);
    expect(canConvertSchema({ notASchema: true })).toBe(false);
    expect(canConvertSchema(() => true)).toBe(false);
  });
});
