import { task } from '@trigger.dev/sdk/v3';
import { z } from 'zod';
import { schemaToJsonSchema, type JSONSchema } from '@trigger.dev/schema-to-json';

// Example 1: Using schemaTask (automatic conversion)
import { schemaTask } from '@trigger.dev/sdk/v3';

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  age: z.number().int().min(0),
});

export const processUser = schemaTask({
  id: 'process-user',
  schema: userSchema,
  run: async (payload) => {
    // payload is fully typed based on the schema
    console.log(`Processing user ${payload.name}`);
    return { processed: true };
  },
});

// Example 2: Using plain task with manual JSON Schema
export const processOrder = task({
  id: 'process-order',
  // Manually provide JSON Schema for the payload
  payloadSchema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
            quantity: { type: 'integer', minimum: 1 },
            price: { type: 'number', minimum: 0 },
          },
          required: ['productId', 'quantity', 'price'],
        },
      },
      totalAmount: { type: 'number' },
    },
    required: ['orderId', 'items', 'totalAmount'],
  } satisfies JSONSchema,
  run: async (payload) => {
    // payload is typed as any, but the schema will be validated at runtime
    console.log(`Processing order ${payload.orderId}`);
    return { processed: true };
  },
});

// Example 3: Using plain task with schema conversion
const orderSchema = z.object({
  orderId: z.string(),
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().int().min(1),
    price: z.number().min(0),
  })),
  totalAmount: z.number(),
});

// Convert the schema to JSON Schema
const orderJsonSchema = schemaToJsonSchema(orderSchema);

export const processOrderWithConversion = task({
  id: 'process-order-converted',
  // Use the converted JSON Schema
  payloadSchema: orderJsonSchema?.jsonSchema,
  run: async (payload) => {
    // Note: You still need to validate the payload yourself in plain tasks
    const parsed = orderSchema.parse(payload);
    console.log(`Processing order ${parsed.orderId}`);
    return { processed: true };
  },
});

// Example 4: Type-safe JSON Schema creation
import { Type, Static } from '@sinclair/typebox';

const typeBoxSchema = Type.Object({
  userId: Type.String(),
  action: Type.Union([
    Type.Literal('create'),
    Type.Literal('update'),
    Type.Literal('delete'),
  ]),
  timestamp: Type.Number(),
});

type UserAction = Static<typeof typeBoxSchema>;

export const processUserAction = task({
  id: 'process-user-action',
  // TypeBox schemas are already JSON Schema compliant
  payloadSchema: typeBoxSchema,
  run: async (payload) => {
    // Cast to get type safety (or validate at runtime)
    const action = payload as UserAction;
    console.log(`User ${action.userId} performed ${action.action}`);
    return { processed: true };
  },
});