// Import JSONSchema from core to ensure compatibility
import type { JSONSchema } from "@trigger.dev/core/v3";

export type Schema = unknown;
export type { JSONSchema };

export interface ConversionOptions {
  /**
   * The name to use for the schema in the JSON Schema
   */
  name?: string;
  /**
   * Additional JSON Schema properties to merge
   */
  additionalProperties?: Record<string, unknown>;
}

export interface ConversionResult {
  /**
   * The JSON Schema representation (JSON Schema Draft 7)
   */
  jsonSchema: JSONSchema;
  /**
   * The detected schema type
   */
  schemaType:
    | "zod"
    | "yup"
    | "arktype"
    | "effect"
    | "valibot"
    | "superstruct"
    | "runtypes"
    | "typebox"
    | "unknown";
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
      // Determine if it's Zod or ArkType based on other methods
      const schemaType =
        typeof parser.parseAsync === "function" || typeof parser.parse === "function"
          ? "zod"
          : "arktype";
      return {
        jsonSchema: options?.additionalProperties
          ? { ...jsonSchema, ...options.additionalProperties }
          : jsonSchema,
        schemaType,
      };
    } catch (error) {
      // If toJsonSchema fails, continue to other checks
    }
  }

  // Check if it's a TypeBox schema (has Static and Kind symbols)
  if (parser[Symbol.for("TypeBox.Kind")] !== undefined) {
    // TypeBox schemas are already JSON Schema compliant
    return {
      jsonSchema: options?.additionalProperties
        ? { ...parser, ...options.additionalProperties }
        : parser,
      schemaType: "typebox",
    };
  }

  // For schemas that need external libraries, we need to check if they're available
  // This approach avoids bundling the dependencies while still allowing runtime usage

  // Check if it's a Zod schema (without built-in toJsonSchema)
  if (typeof parser.parseAsync === "function" || typeof parser.parse === "function") {
    try {
      // Try to access zod-to-json-schema if it's available
      // @ts-ignore - This is intentionally dynamic
      if (typeof globalThis.__zodToJsonSchema !== "undefined") {
        // @ts-ignore
        const { zodToJsonSchema } = globalThis.__zodToJsonSchema;
        const jsonSchema = options?.name
          ? zodToJsonSchema(parser, options.name)
          : zodToJsonSchema(parser);

        if (jsonSchema && typeof jsonSchema === "object" && "$schema" in jsonSchema) {
          const { $schema, ...rest } = jsonSchema as any;
          return {
            jsonSchema: options?.additionalProperties
              ? { ...rest, ...options.additionalProperties }
              : rest,
            schemaType: "zod",
          };
        }

        return {
          jsonSchema: options?.additionalProperties
            ? { ...jsonSchema, ...options.additionalProperties }
            : jsonSchema,
          schemaType: "zod",
        };
      }
    } catch (error) {
      // Library not available
    }
  }

  // Check if it's a Yup schema
  if (typeof parser.validateSync === "function" && typeof parser.describe === "function") {
    try {
      // @ts-ignore
      if (typeof globalThis.__yupToJsonSchema !== "undefined") {
        // @ts-ignore
        const { convertSchema } = globalThis.__yupToJsonSchema;
        const jsonSchema = convertSchema(parser);
        return {
          jsonSchema: options?.additionalProperties
            ? { ...jsonSchema, ...options.additionalProperties }
            : jsonSchema,
          schemaType: "yup",
        };
      }
    } catch (error) {
      // Library not available
    }
  }

  // Check if it's an Effect schema
  if (
    parser._tag === "Schema" ||
    parser._tag === "SchemaClass" ||
    typeof parser.ast === "function"
  ) {
    try {
      // @ts-ignore
      if (typeof globalThis.__effectJsonSchema !== "undefined") {
        // @ts-ignore
        const { JSONSchema } = globalThis.__effectJsonSchema;
        const jsonSchema = JSONSchema.make(parser);
        return {
          jsonSchema: options?.additionalProperties
            ? { ...jsonSchema, ...options.additionalProperties }
            : jsonSchema,
          schemaType: "effect",
        };
      }
    } catch (error) {
      // Library not available
    }
  }

  // Future schema types can be added here...

  // Unknown schema type
  return undefined;
}

/**
 * Initialize the schema conversion libraries
 * This should be called by the consuming application if they want to enable
 * conversion for schemas that don't have built-in JSON Schema support
 */
export async function initializeSchemaConverters(): Promise<void> {
  try {
    // @ts-ignore
    globalThis.__zodToJsonSchema = await import("zod-to-json-schema");
  } catch {
    // Zod conversion not available
  }

  try {
    // @ts-ignore
    globalThis.__yupToJsonSchema = await import("@sodaru/yup-to-json-schema");
  } catch {
    // Yup conversion not available
  }

  try {
    // Try Effect first, then @effect/schema
    let module;
    try {
      module = await import("effect");
    } catch {
      module = await import("@effect/schema");
    }
    if (module?.JSONSchema) {
      // @ts-ignore
      globalThis.__effectJsonSchema = { JSONSchema: module.JSONSchema };
    }
  } catch {
    // Effect conversion not available
  }
}

/**
 * Check if a schema can be converted to JSON Schema
 */
export function canConvertSchema(schema: Schema): boolean {
  const result = schemaToJsonSchema(schema);
  return result !== undefined;
}

/**
 * Get the detected schema type
 */
export function detectSchemaType(schema: Schema): ConversionResult["schemaType"] {
  const result = schemaToJsonSchema(schema);
  return result?.schemaType ?? "unknown";
}

/**
 * Check if the conversion libraries are initialized
 */
export function areConvertersInitialized(): {
  zod: boolean;
  yup: boolean;
  effect: boolean;
} {
  return {
    // @ts-ignore
    zod: typeof globalThis.__zodToJsonSchema !== "undefined",
    // @ts-ignore
    yup: typeof globalThis.__yupToJsonSchema !== "undefined",
    // @ts-ignore
    effect: typeof globalThis.__effectJsonSchema !== "undefined",
  };
}
