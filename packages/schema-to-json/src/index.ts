export type Schema = unknown;

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
   * The JSON Schema representation
   */
  jsonSchema: any;
  /**
   * The detected schema type
   */
  schemaType: 'zod' | 'yup' | 'arktype' | 'effect' | 'valibot' | 'superstruct' | 'runtypes' | 'typebox' | 'unknown';
}

/**
 * Convert a schema from various validation libraries to JSON Schema
 */
export function schemaToJsonSchema(schema: Schema, options?: ConversionOptions): ConversionResult | undefined {
  const parser = schema as any;

  // Check if schema has a built-in toJsonSchema method (e.g., ArkType)
  if (typeof parser.toJsonSchema === "function") {
    const jsonSchema = parser.toJsonSchema();
    return {
      jsonSchema: options?.additionalProperties ? { ...jsonSchema, ...options.additionalProperties } : jsonSchema,
      schemaType: 'arktype'
    };
  }

  // Check if it's a TypeBox schema (has Static and Kind symbols)
  if (parser[Symbol.for('TypeBox.Kind')] !== undefined) {
    // TypeBox schemas are already JSON Schema compliant
    return {
      jsonSchema: options?.additionalProperties ? { ...parser, ...options.additionalProperties } : parser,
      schemaType: 'typebox'
    };
  }

  // Check if it's a Zod schema
  if (typeof parser.parseAsync === "function" || typeof parser.parse === "function") {
    try {
      const { zodToJsonSchema } = require('zod-to-json-schema');
      const jsonSchema = options?.name 
        ? zodToJsonSchema(parser, options.name)
        : zodToJsonSchema(parser);
      
      if (jsonSchema && typeof jsonSchema === 'object' && '$schema' in jsonSchema) {
        // Remove the $schema property as it's not needed for our use case
        const { $schema, ...rest } = jsonSchema as any;
        return {
          jsonSchema: options?.additionalProperties ? { ...rest, ...options.additionalProperties } : rest,
          schemaType: 'zod'
        };
      }
      
      return {
        jsonSchema: options?.additionalProperties ? { ...jsonSchema, ...options.additionalProperties } : jsonSchema,
        schemaType: 'zod'
      };
    } catch (error) {
      console.warn('Failed to convert Zod schema to JSON Schema:', error);
      return undefined;
    }
  }

  // Check if it's a Yup schema
  if (typeof parser.validateSync === "function" && typeof parser.describe === "function") {
    try {
      const { convertSchema } = require('@sodaru/yup-to-json-schema');
      const jsonSchema = convertSchema(parser);
      return {
        jsonSchema: options?.additionalProperties ? { ...jsonSchema, ...options.additionalProperties } : jsonSchema,
        schemaType: 'yup'
      };
    } catch (error) {
      console.warn('Failed to convert Yup schema to JSON Schema:', error);
      return undefined;
    }
  }

  // Check if it's an Effect schema
  if (parser._tag === "Schema" || parser._tag === "SchemaClass" || typeof parser.ast === "function") {
    try {
      // Try to load Effect's JSONSchema module
      const effectModule = require('effect');
      const schemaModule = require('@effect/schema');
      
      if (effectModule?.JSONSchema && schemaModule?.JSONSchema) {
        const JSONSchema = schemaModule.JSONSchema || effectModule.JSONSchema;
        const jsonSchema = JSONSchema.make(parser);
        return {
          jsonSchema: options?.additionalProperties ? { ...jsonSchema, ...options.additionalProperties } : jsonSchema,
          schemaType: 'effect'
        };
      }
    } catch (error) {
      console.warn('Failed to convert Effect schema to JSON Schema:', error);
      return undefined;
    }
  }

  // Check if it's a Valibot schema
  if (typeof parser === "function" && parser._def?.kind !== undefined) {
    // Valibot doesn't have built-in JSON Schema conversion yet
    // We could implement a basic converter for common types
    return undefined;
  }

  // Check if it's a Superstruct schema
  if (typeof parser.create === "function" && parser.TYPE !== undefined) {
    // Superstruct doesn't have built-in JSON Schema conversion
    // We could implement a basic converter for common types
    return undefined;
  }

  // Check if it's a Runtypes schema
  if (typeof parser.guard === "function" && parser._tag !== undefined) {
    // Runtypes doesn't have built-in JSON Schema conversion
    // We could implement a basic converter for common types
    return undefined;
  }

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

/**
 * Get the detected schema type
 */
export function detectSchemaType(schema: Schema): ConversionResult['schemaType'] {
  const result = schemaToJsonSchema(schema);
  return result?.schemaType ?? 'unknown';
}