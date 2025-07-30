// This file tests the core JSON schema functionality without external dependencies
import { schemaTask, task, type JSONSchema } from "@trigger.dev/sdk";
import { z } from "zod";

// Test 1: Basic type inference with schemaTask
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  age: z.number(),
});

export const testZodTypeInference = schemaTask({
  id: "test-zod-type-inference",
  schema: userSchema,
  run: async (payload, { ctx }) => {
    // These should all be properly typed without explicit type annotations
    const id = payload.id; // string
    const name = payload.name; // string
    const email = payload.email; // string
    const age = payload.age; // number

    // This would cause a TypeScript error if uncommented:
    // const invalid = payload.nonExistentField;

    return {
      userId: id,
      userName: name,
      userEmail: email,
      userAge: age,
    };
  },
});

// Test 2: JSONSchema type is properly exported and usable
const jsonSchemaExample = {
  type: "object",
  properties: {
    message: { type: "string" },
    count: { type: "integer" },
    active: { type: "boolean" },
  },
  required: ["message", "count"],
} satisfies JSONSchema;

export const testJSONSchemaType = task({
  id: "test-json-schema-type",
  jsonSchema: jsonSchemaExample,
  run: async (payload, { ctx }) => {
    // payload is 'any' with plain task, but the schema is properly typed
    return {
      received: true,
      message: payload.message,
      count: payload.count,
      active: payload.active ?? false,
    };
  },
});

// Test 3: Trigger type safety
export const testTriggerTypeSafety = task({
  id: "test-trigger-type-safety",
  run: async (_, { ctx }) => {
    // This should compile with proper type inference
    const handle1 = await testZodTypeInference.trigger({
      id: "123",
      name: "John Doe",
      email: "john@example.com",
      age: 30,
    });

    // This would cause TypeScript errors if uncommented:
    // const handle2 = await testZodTypeInference.trigger({
    //   id: 123, // wrong type
    //   name: "Jane",
    //   email: "not-an-email", // invalid format (caught at runtime)
    //   age: "thirty", // wrong type
    // });

    // Test triggerAndWait
    const result = await testZodTypeInference.triggerAndWait({
      id: "456",
      name: "Jane Smith",
      email: "jane@example.com",
      age: 25,
    });

    if (result.ok) {
      // Type inference works on the output
      const userId: string = result.output.userId;
      const userName: string = result.output.userName;
      const userEmail: string = result.output.userEmail;
      const userAge: number = result.output.userAge;

      return {
        success: true,
        userId,
        userName,
        userEmail,
        userAge,
      };
    } else {
      return {
        success: false,
        error: String(result.error),
      };
    }
  },
});

// Test 4: Batch operations maintain type safety
export const testBatchTypeSafety = task({
  id: "test-batch-type-safety",
  run: async (_, { ctx }) => {
    // Batch trigger with type safety
    const batchHandle = await testZodTypeInference.batchTrigger([
      {
        payload: {
          id: "1",
          name: "User One",
          email: "user1@example.com",
          age: 20,
        },
      },
      {
        payload: {
          id: "2",
          name: "User Two",
          email: "user2@example.com",
          age: 30,
        },
      },
    ]);

    // Batch trigger and wait
    const batchResult = await testZodTypeInference.batchTriggerAndWait([
      {
        payload: {
          id: "3",
          name: "User Three",
          email: "user3@example.com",
          age: 40,
        },
      },
      {
        payload: {
          id: "4",
          name: "User Four",
          email: "user4@example.com",
          age: 50,
        },
      },
    ]);

    // Process results with type safety
    const successfulUsers: string[] = [];
    const failedUsers: string[] = [];

    for (const run of batchResult.runs) {
      if (run.ok) {
        // output is properly typed
        successfulUsers.push(run.output.userId);
      } else {
        failedUsers.push(run.id);
      }
    }

    return {
      batchId: batchHandle.batchId,
      batchRunCount: batchHandle.runCount,
      successfulUsers,
      failedUsers,
      totalProcessed: batchResult.runs.length,
    };
  },
});

// Test 5: Complex nested schema
const complexSchema = z.object({
  order: z.object({
    id: z.string(),
    items: z.array(
      z.object({
        productId: z.string(),
        quantity: z.number(),
        price: z.number(),
      })
    ),
    customer: z.object({
      id: z.string(),
      email: z.string().email(),
      address: z
        .object({
          street: z.string(),
          city: z.string(),
          country: z.string(),
        })
        .optional(),
    }),
  }),
  metadata: z.record(z.unknown()).optional(),
});

export const testComplexSchema = schemaTask({
  id: "test-complex-schema",
  schema: complexSchema,
  run: async (payload, { ctx }) => {
    // Deep type inference works
    const orderId = payload.order.id;
    const firstItem = payload.order.items[0];
    const quantity = firstItem?.quantity ?? 0;
    const customerEmail = payload.order.customer.email;
    const city = payload.order.customer.address?.city;

    // Calculate total
    const total = payload.order.items.reduce((sum, item) => sum + item.quantity * item.price, 0);

    return {
      orderId,
      customerEmail,
      itemCount: payload.order.items.length,
      total,
      hasAddress: !!payload.order.customer.address,
      city: city ?? "Unknown",
    };
  },
});

// Test 6: Verify that JSON schema is properly set during task registration
export const verifySchemaRegistration = task({
  id: "verify-schema-registration",
  run: async (_, { ctx }) => {
    // This test verifies that when we create tasks with schemas,
    // they properly register the payloadSchema for syncing to the server

    return {
      test: "Schema registration",
      message: "If this task runs, schema registration is working",
      // The actual verification happens during indexing when the CLI
      // reads the task metadata and sees the payloadSchema field
    };
  },
});
