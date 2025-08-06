import { z } from "zod";
import * as y from "yup";
// @ts-ignore
import { type } from "arktype";
import { Schema } from "effect";
import { Type } from "@sinclair/typebox";
import {
  schemaToJsonSchema,
  canConvertSchema,
  detectSchemaType,
  initializeSchemaConverters,
  areConvertersInitialized,
} from "../src/index.js";

// Initialize converters before running tests
beforeAll(async () => {
  await initializeSchemaConverters();
});

describe("schemaToJsonSchema", () => {
  describe("Initialization", () => {
    it("should have converters initialized", () => {
      const status = areConvertersInitialized();
      expect(status.zod).toBe(true);
      expect(status.yup).toBe(true);
      expect(status.effect).toBe(true);
    });
  });

  describe("Zod schemas", () => {
    it("should convert a simple Zod object schema", () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
        email: z.string().email(),
      });

      const result = schemaToJsonSchema(schema);

      expect(result).toBeDefined();
      expect(result?.schemaType).toBe("zod");
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
      const schema = z.object({
        id: z.string(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
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
      const schema = z.object({
        value: z.number(),
      });

      const result = schemaToJsonSchema(schema, { name: "MySchema" });

      expect(result).toBeDefined();
      expect(result?.jsonSchema).toBeDefined();
      // The exact structure depends on zod-to-json-schema implementation
    });

    it("should handle Zod 4 schema with built-in toJsonSchema method", () => {
      // Mock a Zod 4 schema with toJsonSchema method
      const mockZod4Schema = {
        parse: (val: unknown) => val,
        parseAsync: async (val: unknown) => val,
        toJsonSchema: () => ({
          type: "object",
          properties: {
            id: { type: "string" },
            count: { type: "number" },
          },
          required: ["id", "count"],
        }),
      };

      const result = schemaToJsonSchema(mockZod4Schema);

      expect(result).toBeDefined();
      expect(result?.schemaType).toBe("zod");
      expect(result?.jsonSchema).toEqual({
        type: "object",
        properties: {
          id: { type: "string" },
          count: { type: "number" },
        },
        required: ["id", "count"],
      });
    });
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
      expect(result?.schemaType).toBe("yup");
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
      expect(result?.schemaType).toBe("arktype");
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
      expect(result?.schemaType).toBe("effect");
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
      expect(result?.schemaType).toBe("typebox");
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

  describe("Additional options", () => {
    it("should merge additional properties", () => {
      const schema = z.object({
        value: z.number(),
      });

      const result = schemaToJsonSchema(schema, {
        additionalProperties: {
          title: "My Schema",
          description: "A test schema",
          "x-custom": "custom value",
        },
      });

      expect(result).toBeDefined();
      expect(result?.jsonSchema.title).toBe("My Schema");
      expect(result?.jsonSchema.description).toBe("A test schema");
      expect(result?.jsonSchema["x-custom"]).toBe("custom value");
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
    expect(canConvertSchema(z.string())).toBe(true);
    expect(canConvertSchema(y.string())).toBe(true);
    expect(canConvertSchema(type("string"))).toBe(true);
    expect(canConvertSchema(Schema.String)).toBe(true);
    expect(canConvertSchema(Type.String())).toBe(true);
  });

  it("should return false for unsupported schemas", () => {
    expect(canConvertSchema({ notASchema: true })).toBe(false);
    expect(canConvertSchema(() => true)).toBe(false);
  });
});

describe("detectSchemaType", () => {
  it("should detect Zod schemas", () => {
    expect(detectSchemaType(z.string())).toBe("zod");
  });

  it("should detect Yup schemas", () => {
    expect(detectSchemaType(y.string())).toBe("yup");
  });

  it("should detect ArkType schemas", () => {
    expect(detectSchemaType(type("string"))).toBe("arktype");
  });

  it("should detect Effect schemas", () => {
    expect(detectSchemaType(Schema.String)).toBe("effect");
  });

  it("should detect TypeBox schemas", () => {
    expect(detectSchemaType(Type.String())).toBe("typebox");
  });

  it("should return unknown for unsupported schemas", () => {
    expect(detectSchemaType({ notASchema: true })).toBe("unknown");
  });
});
