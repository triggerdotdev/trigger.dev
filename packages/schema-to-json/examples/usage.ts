// This file shows how @trigger.dev/schema-to-json is used INTERNALLY by the SDK
// Regular users should NOT import this package directly!

import { schemaToJsonSchema, type JSONSchema } from '@trigger.dev/schema-to-json';
import { z } from 'zod';

// Example of how the SDK uses this internally:

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  age: z.number().int().min(0),
});

// This is what happens internally in the SDK's schemaTask:
const result = schemaToJsonSchema(userSchema);
if (result) {
  console.log('Converted Zod schema to JSON Schema:', result.jsonSchema);
  console.log('Detected schema type:', result.schemaType);
  // The SDK then includes this JSON Schema in the task metadata
}

// Example: How different schema libraries are detected and converted

// Yup schema
import * as y from 'yup';
const yupSchema = y.object({
  name: y.string().required(),
  age: y.number().required(),
});

const yupResult = schemaToJsonSchema(yupSchema);
console.log('Yup conversion:', yupResult);

// ArkType schema (has built-in toJsonSchema)
import { type } from 'arktype';
const arkSchema = type({
  name: 'string',
  age: 'number',
});

const arkResult = schemaToJsonSchema(arkSchema);
console.log('ArkType conversion:', arkResult);

// TypeBox (already JSON Schema)
import { Type } from '@sinclair/typebox';
const typeBoxSchema = Type.Object({
  name: Type.String(),
  age: Type.Number(),
});

const typeBoxResult = schemaToJsonSchema(typeBoxSchema);
console.log('TypeBox conversion:', typeBoxResult);

// Example: Initialization (done automatically by the SDK)
import { initializeSchemaConverters, areConvertersInitialized } from '@trigger.dev/schema-to-json';

// The SDK calls this once when it loads
await initializeSchemaConverters();

// Check which converters are available
const status = areConvertersInitialized();
console.log('Converter status:', status);
// { zod: true, yup: true, effect: true }

// Example: How the SDK determines if a schema can be converted
import { canConvertSchema, detectSchemaType } from '@trigger.dev/schema-to-json';

const zodSchema = z.string();
console.log('Can convert Zod?', canConvertSchema(zodSchema)); // true
console.log('Schema type:', detectSchemaType(zodSchema)); // 'zod'

// For users: Just use the SDK!
// import { schemaTask } from '@trigger.dev/sdk/v3';
// 
// export const myTask = schemaTask({
//   id: 'my-task',
//   schema: zodSchema,
//   run: async (payload) => { /* ... */ }
// });