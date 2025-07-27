# @trigger.dev/schema-to-json

Convert various schema validation libraries to JSON Schema format.

## Installation

```bash
npm install @trigger.dev/schema-to-json
```

## Important: Bundle Safety

This package is designed to be **bundle-safe**. It does NOT bundle any schema libraries (zod, yup, etc.) as dependencies. Instead:

1. **Built-in conversions** work immediately (ArkType, Zod 4, TypeBox)
2. **External conversions** (Zod 3, Yup, Effect) require the conversion libraries to be available at runtime

This design ensures that:
- ✅ Your bundle size stays small
- ✅ You only include the schema libraries you actually use
- ✅ Tree-shaking works properly
- ✅ No unnecessary dependencies are installed

## Supported Schema Libraries

- ✅ **Zod** - Full support
  - Zod 4: Native support via built-in `toJsonSchema` method (no external deps needed)
  - Zod 3: Requires `zod-to-json-schema` to be installed
- ✅ **Yup** - Requires `@sodaru/yup-to-json-schema` to be installed
- ✅ **ArkType** - Native support (built-in `toJsonSchema` method)
- ✅ **Effect/Schema** - Requires `effect` or `@effect/schema` to be installed
- ✅ **TypeBox** - Native support (already JSON Schema compliant)
- ⏳ **Valibot** - Coming soon
- ⏳ **Superstruct** - Coming soon
- ⏳ **Runtypes** - Coming soon

## Usage

### Basic Usage (Built-in conversions only)

```typescript
import { schemaToJsonSchema } from '@trigger.dev/schema-to-json';
import { type } from 'arktype';

// Works immediately for schemas with built-in conversion
const arkSchema = type({
  name: 'string',
  age: 'number',
});

const result = schemaToJsonSchema(arkSchema);
console.log(result);
// { jsonSchema: {...}, schemaType: 'arktype' }
```

### Full Usage (With external conversion libraries)

```typescript
import { schemaToJsonSchema, initializeSchemaConverters } from '@trigger.dev/schema-to-json';
import { z } from 'zod';

// Initialize converters once in your app (loads conversion libraries if available)
await initializeSchemaConverters();

// Now you can convert Zod 3, Yup, and Effect schemas
const zodSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email(),
});

const result = schemaToJsonSchema(zodSchema);
console.log(result);
// {
//   jsonSchema: {
//     type: 'object',
//     properties: {
//       name: { type: 'string' },
//       age: { type: 'number' },
//       email: { type: 'string', format: 'email' }
//     },
//     required: ['name', 'age', 'email']
//   },
//   schemaType: 'zod'
// }
```

## API

### `schemaToJsonSchema(schema, options?)`

Convert a schema to JSON Schema format.

**Parameters:**
- `schema` - The schema to convert
- `options` (optional)
  - `name` - Name to use for the schema (supported by some converters)
  - `additionalProperties` - Additional properties to merge into the result

**Returns:**
- `{ jsonSchema, schemaType }` - The converted JSON Schema and detected type
- `undefined` - If the schema cannot be converted

### `initializeSchemaConverters()`

Initialize the external conversion libraries. Call this once in your application if you need to convert schemas that don't have built-in JSON Schema support (Zod 3, Yup, Effect).

**Returns:** `Promise<void>`

### `canConvertSchema(schema)`

Check if a schema can be converted to JSON Schema.

**Returns:** `boolean`

### `detectSchemaType(schema)`

Detect the type of schema.

**Returns:** `'zod' | 'yup' | 'arktype' | 'effect' | 'valibot' | 'superstruct' | 'runtypes' | 'typebox' | 'unknown'`

### `areConvertersInitialized()`

Check which conversion libraries are available.

**Returns:** `{ zod: boolean, yup: boolean, effect: boolean }`

## Peer Dependencies

Each schema library is an optional peer dependency. Install only the ones you need:

```bash
# For Zod
npm install zod

# For Yup
npm install yup

# For ArkType
npm install arktype

# For Effect
npm install effect @effect/schema

# For TypeBox
npm install @sinclair/typebox
```

## License

MIT