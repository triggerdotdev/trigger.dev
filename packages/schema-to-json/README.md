# @trigger.dev/schema-to-json

Convert various schema validation libraries to JSON Schema format.

## Installation

```bash
npm install @trigger.dev/schema-to-json
```

## Supported Schema Libraries

- ✅ **Zod** - Full support
  - Zod 4: Native support via built-in `toJsonSchema` method
  - Zod 3: Support via `zod-to-json-schema` library
- ✅ **Yup** - Full support via `@sodaru/yup-to-json-schema`
- ✅ **ArkType** - Native support (built-in `toJsonSchema` method)
- ✅ **Effect/Schema** - Full support via Effect's JSONSchema module
- ✅ **TypeBox** - Native support (already JSON Schema compliant)
- ⏳ **Valibot** - Coming soon
- ⏳ **Superstruct** - Coming soon
- ⏳ **Runtypes** - Coming soon

## Usage

```typescript
import { schemaToJsonSchema } from '@trigger.dev/schema-to-json';
import { z } from 'zod';

// Convert a Zod schema
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

### `canConvertSchema(schema)`

Check if a schema can be converted to JSON Schema.

**Returns:** `boolean`

### `detectSchemaType(schema)`

Detect the type of schema.

**Returns:** `'zod' | 'yup' | 'arktype' | 'effect' | 'valibot' | 'superstruct' | 'runtypes' | 'typebox' | 'unknown'`

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