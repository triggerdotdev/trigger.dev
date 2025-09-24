// Import JSONSchema from core to ensure compatibility
import type { JSONSchema } from "@trigger.dev/core/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as z4 from "zod/v4";
import { convertSchema } from "@sodaru/yup-to-json-schema";
import { JSONSchema as EffectJSONSchema } from "effect";

export type Schema = unknown;
export type { JSONSchema };

export interface ConversionOptions {
  /**
   * Enables support for references in the schema.
   * This is required for recursive schemas, e.g. with `z.lazy`.
   * However, not all language models and providers support such references.
   * Defaults to `false`.
   */
  useReferences?: boolean;
}

export interface ConversionResult {
  /**
   * The JSON Schema representation (JSON Schema Draft 7)
   */
  jsonSchema: JSONSchema;
}

/**
 * Convert a schema from various validation libraries to JSON Schema
 *
 * This function attempts to convert schemas without requiring external dependencies to be bundled.
 * It will only succeed if:
 * 1. The schema has built-in JSON Schema conversion (ArkType, Zod 4, TypeBox)
 * 2. The required conversion library is available at runtime (zod-to-json-schema, @sodaru/yup-to-json-schema, etc.)
 *
 * @param schema The schema to convert
 * @param options Optional conversion options
 * @returns The conversion result or undefined if conversion is not possible
 */
export function schemaToJsonSchema(
  schema: Schema,
  options?: ConversionOptions
): ConversionResult | undefined {
  const parser = schema as any;

  // Check if schema has a built-in toJsonSchema method (e.g., ArkType, Zod 4)
  if (typeof parser.toJsonSchema === "function") {
    try {
      const jsonSchema = parser.toJsonSchema();

      return {
        jsonSchema,
      };
    } catch (error) {
      // If toJsonSchema fails, continue to other checks
    }
  }

  if (isZodSchema(parser)) {
    const jsonSchema = convertZodSchema(parser, options);

    if (jsonSchema) {
      return {
        jsonSchema: jsonSchema,
      };
    }
  }

  // Check if it's a TypeBox schema (has Static and Kind symbols)
  if (parser[Symbol.for("TypeBox.Kind")] !== undefined) {
    // TypeBox schemas are already JSON Schema compliant
    return {
      jsonSchema: parser,
    };
  }

  if (isYupSchema(parser)) {
    const jsonSchema = convertYupSchema(parser);
    if (jsonSchema) {
      return {
        jsonSchema: jsonSchema,
      };
    }
  }

  if (isEffectSchema(parser)) {
    const jsonSchema = convertEffectSchema(parser);
    if (jsonSchema) {
      return {
        jsonSchema: jsonSchema,
      };
    }
  }

  // Future schema types can be added here...

  // Unknown schema type
  return undefined;
}

/**
 * Check if a schema can be converted to JSON Schema
 */
export function canConvertSchema(schema: Schema): boolean {
  const result = schemaToJsonSchema(schema);
  return result !== undefined;
}

export function isZodSchema(schema: any): boolean {
  return isZod3Schema(schema) || isZod4Schema(schema);
}

function isZod3Schema(schema: any): boolean {
  return "_def" in schema && "parse" in schema && "parseAsync" in schema && "safeParse" in schema;
}

function isZod4Schema(schema: any): boolean {
  return "_zod" in schema;
}

function convertZodSchema(schema: any, options?: ConversionOptions): JSONSchema | undefined {
  if (isZod4Schema(schema)) {
    return convertZod4Schema(schema, options);
  }

  if (isZod3Schema(schema)) {
    return convertZod3Schema(schema, options);
  }

  return undefined;
}

function convertZod3Schema(schema: any, options?: ConversionOptions): JSONSchema | undefined {
  const useReferences = options?.useReferences ?? false;

  return zodToJsonSchema(schema, {
    $refStrategy: useReferences ? "root" : "none",
  }) as JSONSchema;
}

function convertZod4Schema(schema: any, options?: ConversionOptions): JSONSchema | undefined {
  const useReferences = options?.useReferences ?? false;

  return z4.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
    reused: useReferences ? "ref" : "inline",
  }) as JSONSchema;
}

function isYupSchema(schema: any): boolean {
  return "spec" in schema && "_typeCheck" in schema;
}

function convertYupSchema(schema: any): JSONSchema | undefined {
  try {
    return convertSchema(schema) as JSONSchema;
  } catch {
    return undefined;
  }
}

function isEffectSchema(schema: any): boolean {
  return "ast" in schema && typeof schema.ast === "object" && typeof schema.ast._tag === "string";
}

function convertEffectSchema(schema: any): JSONSchema | undefined {
  try {
    return EffectJSONSchema.make(schema) as JSONSchema;
  } catch {
    return undefined;
  }
}
