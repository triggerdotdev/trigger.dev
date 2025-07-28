// Standalone type test to verify JSON schema implementation
// This imports directly from the source files to test compilation

import { schemaTask, task } from "../../packages/trigger-sdk/src/v3/index.js";
import type { JSONSchema } from "../../packages/trigger-sdk/src/v3/index.js";
import { z } from "zod";

// Test 1: JSONSchema type is properly exported
const testJsonSchemaType: JSONSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string", minLength: 1 },
    age: { type: "integer", minimum: 0, maximum: 150 },
    email: { type: "string", format: "email" },
    tags: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 10,
    },
    active: { type: "boolean" },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["id", "name", "email"],
  additionalProperties: false,
};

// Test 2: Plain task accepts JSONSchema type
const plainTask = task({
  id: "plain-task-with-schema",
  payloadSchema: testJsonSchemaType, // This should compile without errors
  run: async (payload, { ctx }) => {
    return { processed: true };
  },
});

// Test 3: Schema task with Zod
const zodSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  userEmail: z.string().email(),
  isActive: z.boolean(),
  score: z.number(),
  tags: z.array(z.string()),
  metadata: z.record(z.unknown()).optional(),
});

const zodTask = schemaTask({
  id: "zod-schema-task",
  schema: zodSchema,
  run: async (payload, { ctx }) => {
    // Type checking - all these should be properly typed
    const userId: string = payload.userId;
    const userName: string = payload.userName;
    const userEmail: string = payload.userEmail;
    const isActive: boolean = payload.isActive;
    const score: number = payload.score;
    const tags: string[] = payload.tags;
    const metadata: Record<string, unknown> | undefined = payload.metadata;
    
    return {
      processedUserId: userId,
      processedUserName: userName,
      tagCount: tags.length,
    };
  },
});

// Test 4: Complex nested schemas
const nestedSchema = z.object({
  order: z.object({
    orderId: z.string().uuid(),
    items: z.array(z.object({
      itemId: z.string(),
      quantity: z.number().positive(),
      unitPrice: z.number().positive(),
    })),
    customer: z.object({
      customerId: z.string(),
      email: z.string().email(),
      shipping: z.object({
        address: z.string(),
        city: z.string(),
        postalCode: z.string(),
        country: z.string(),
      }).optional(),
    }),
    status: z.enum(["pending", "processing", "shipped", "delivered"]),
  }),
  createdAt: z.string().datetime(),
  notes: z.string().optional(),
});

const nestedTask = schemaTask({
  id: "nested-schema-task",
  schema: nestedSchema,
  run: async (payload, { ctx }) => {
    // Deep property access with full type safety
    const orderId = payload.order.orderId;
    const firstItem = payload.order.items[0];
    const quantity = firstItem?.quantity ?? 0;
    const email = payload.order.customer.email;
    const city = payload.order.customer.shipping?.city;
    const status = payload.order.status;
    
    // Status is properly typed as enum
    const isShipped: boolean = status === "shipped" || status === "delivered";
    
    return {
      orderId,
      customerEmail: email,
      itemCount: payload.order.items.length,
      isShipped,
      shippingCity: city ?? "N/A",
    };
  },
});

// Test 5: Trigger type safety
async function testTriggerTypes() {
  // Valid trigger calls - should compile
  const handle1 = await zodTask.trigger({
    userId: "123",
    userName: "John Doe",
    userEmail: "john@example.com",
    isActive: true,
    score: 95.5,
    tags: ["premium", "verified"],
    metadata: { source: "web" },
  });
  
  // The following would cause TypeScript errors if uncommented:
  /*
  const handle2 = await zodTask.trigger({
    userId: 123, // Error: Type 'number' is not assignable to type 'string'
    userName: "Jane",
    userEmail: "jane@example.com",
    isActive: "yes", // Error: Type 'string' is not assignable to type 'boolean'
    score: "high", // Error: Type 'string' is not assignable to type 'number'
    tags: "single-tag", // Error: Type 'string' is not assignable to type 'string[]'
  });
  
  const handle3 = await zodTask.trigger({
    // Error: Missing required properties
    userId: "456",
    userName: "Bob",
  });
  */
  
  // triggerAndWait with result handling
  const result = await zodTask.triggerAndWait({
    userId: "789",
    userName: "Alice Smith",
    userEmail: "alice@example.com",
    isActive: false,
    score: 88,
    tags: ["new"],
  });
  
  if (result.ok) {
    // Output is properly typed
    const processedId: string = result.output.processedUserId;
    const processedName: string = result.output.processedUserName;
    const tagCount: number = result.output.tagCount;
  }
  
  // Using unwrap
  try {
    const output = await zodTask.triggerAndWait({
      userId: "999",
      userName: "Eve",
      userEmail: "eve@example.com",
      isActive: true,
      score: 100,
      tags: ["admin", "super"],
    }).unwrap();
    
    // Direct access to typed output
    console.log(output.processedUserId);
    console.log(output.processedUserName);
    console.log(output.tagCount);
  } catch (error) {
    console.error("Task failed:", error);
  }
}

// Test 6: Batch operations type safety
async function testBatchTypes() {
  // Batch trigger
  const batchHandle = await zodTask.batchTrigger([
    {
      payload: {
        userId: "b1",
        userName: "Batch User 1",
        userEmail: "batch1@example.com",
        isActive: true,
        score: 75,
        tags: ["batch"],
      },
    },
    {
      payload: {
        userId: "b2",
        userName: "Batch User 2",
        userEmail: "batch2@example.com",
        isActive: false,
        score: 82,
        tags: ["batch", "test"],
      },
    },
  ]);
  
  // Batch trigger and wait
  const batchResult = await zodTask.batchTriggerAndWait([
    {
      payload: {
        userId: "b3",
        userName: "Batch User 3",
        userEmail: "batch3@example.com",
        isActive: true,
        score: 90,
        tags: [],
      },
    },
  ]);
  
  // Process batch results with type safety
  for (const run of batchResult.runs) {
    if (run.ok) {
      const userId: string = run.output.processedUserId;
      const userName: string = run.output.processedUserName;
      const tagCount: number = run.output.tagCount;
    }
  }
}

// Test 7: Verify satisfies works for JSON Schema
const schemaWithSatisfies = {
  type: "object",
  properties: {
    foo: { type: "string" },
  },
  required: ["foo"],
} satisfies JSONSchema;

const taskWithSatisfies = task({
  id: "task-with-satisfies",
  payloadSchema: schemaWithSatisfies,
  run: async (payload) => {
    return { foo: payload.foo };
  },
});

// If this file compiles without errors, our implementation is working correctly!
console.log("Type tests completed successfully!");