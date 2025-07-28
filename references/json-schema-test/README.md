# JSON Schema Test Reference Project

This project demonstrates and tests the JSON schema functionality in Trigger.dev v3.

## Features Implemented

### 1. JSONSchema Type Export
- ✅ Proper `JSONSchema` type based on JSON Schema Draft 7
- ✅ Exported from `@trigger.dev/sdk/v3`
- ✅ Can be used with TypeScript's `satisfies` operator

### 2. Plain Task with payloadSchema
- ✅ Tasks accept a `payloadSchema` property
- ✅ Schema is stored and will be synced during indexing
- ✅ Type-safe schema definition

### 3. Schema Task with Automatic Conversion
- ✅ `schemaTask` automatically converts Zod schemas to JSON Schema
- ✅ Full TypeScript type inference from schema
- ✅ Runtime validation built-in

### 4. Type Safety
- ✅ `trigger()` and `triggerAndWait()` have proper type inference
- ✅ Batch operations maintain type safety
- ✅ Output types are properly inferred

### 5. Schema Conversion Package
- ✅ `@trigger.dev/schema-to-json` package created
- ✅ Supports multiple schema libraries (Zod, Yup, ArkType, etc.)
- ✅ Bundle-safe with dynamic imports
- ✅ Auto-initialized by SDK (no user configuration needed)

## Example Usage

```typescript
import { schemaTask, task, type JSONSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// Option 1: Using schemaTask with Zod (recommended)
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

export const mySchemaTask = schemaTask({
  id: "my-schema-task",
  schema: userSchema,
  run: async (payload, { ctx }) => {
    // payload is fully typed!
    console.log(payload.id, payload.name, payload.email);
    return { processed: true };
  },
});

// Option 2: Using plain task with manual JSON schema
const jsonSchema: JSONSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
  required: ["message"],
};

export const myPlainTask = task({
  id: "my-plain-task",
  payloadSchema: jsonSchema,
  run: async (payload, { ctx }) => {
    // payload is untyped, but schema is stored
    return { received: payload.message };
  },
});
```

## Architecture

1. **Core Package** (`@trigger.dev/core`):
   - Defines `JSONSchema` type
   - Includes `payloadSchema` in task metadata

2. **SDK Package** (`@trigger.dev/sdk`):
   - Re-exports `JSONSchema` type
   - Auto-initializes schema converters
   - Registers `payloadSchema` during task creation

3. **Schema Conversion Package** (`@trigger.dev/schema-to-json`):
   - Converts various schema libraries to JSON Schema
   - Uses dynamic imports for bundle safety
   - Encapsulated as implementation detail

4. **Webapp**:
   - Saves `payloadSchema` to `BackgroundWorkerTask` model
   - Schema available for API documentation, validation, etc.

## Testing

Run the integration test to verify all functionality:

```bash
npm run dev
# Then trigger the integration test task
```

The integration test covers:
- Plain task with JSON schema
- Zod schema conversion
- Complex nested schemas
- Trigger type safety
- Batch operations
- Error handling

## Benefits

1. **Documentation**: Schemas visible in Trigger.dev dashboard
2. **Validation**: Invalid payloads rejected before execution
3. **Type Safety**: Full TypeScript support with schemaTask
4. **API Generation**: Can generate OpenAPI specs
5. **Client SDKs**: Can generate typed clients for other languages