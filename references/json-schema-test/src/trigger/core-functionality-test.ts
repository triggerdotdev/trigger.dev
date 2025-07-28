// Core functionality test - testing JSON schema implementation with minimal dependencies
import { schemaTask, task, type JSONSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// Test 1: Verify JSONSchema type is exported and usable
const manualSchema: JSONSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", format: "email" },
    active: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 100 },
    tags: {
      type: "array",
      items: { type: "string" },
      maxItems: 10,
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["id", "name", "email"],
};

// Test 2: Plain task accepts payloadSchema
export const plainJsonSchemaTask = task({
  id: "plain-json-schema-task",
  payloadSchema: manualSchema,
  run: async (payload, { ctx }) => {
    // payload is any, but schema is properly stored
    console.log("Received payload:", payload);

    return {
      taskId: ctx.task.id,
      runId: ctx.run.id,
      received: true,
      // Manual type assertion needed with plain task
      userId: payload.id as string,
      userName: payload.name as string,
    };
  },
});

// Test 3: Zod schema with automatic conversion
const userSchema = z.object({
  userId: z.string().uuid(),
  userName: z.string().min(2).max(50),
  userEmail: z.string().email(),
  age: z.number().int().min(18).max(120),
  preferences: z.object({
    theme: z.enum(["light", "dark", "auto"]).default("auto"),
    notifications: z.boolean().default(true),
    language: z.string().default("en"),
  }),
  tags: z.array(z.string()).max(5).default([]),
  createdAt: z.string().datetime().optional(),
});

export const zodSchemaTask = schemaTask({
  id: "zod-schema-task",
  schema: userSchema,
  run: async (payload, { ctx }) => {
    // Full type inference from Zod schema
    console.log("Processing user:", payload.userName);

    // All these are properly typed
    const id: string = payload.userId;
    const name: string = payload.userName;
    const email: string = payload.userEmail;
    const age: number = payload.age;
    const theme: "light" | "dark" | "auto" = payload.preferences.theme;
    const notifications: boolean = payload.preferences.notifications;
    const tagCount: number = payload.tags.length;

    return {
      processedUserId: id,
      processedUserName: name,
      processedUserEmail: email,
      userAge: age,
      theme,
      notificationsEnabled: notifications,
      tagCount,
    };
  },
});

// Test 4: Complex nested schema
const orderSchema = z.object({
  orderId: z.string(),
  customerId: z.string(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        productName: z.string(),
        quantity: z.number().positive(),
        unitPrice: z.number().positive(),
        discount: z.number().min(0).max(100).default(0),
      })
    )
    .min(1),
  shippingAddress: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    zipCode: z.string(),
    country: z.string().default("US"),
  }),
  billingAddress: z
    .object({
      street: z.string(),
      city: z.string(),
      state: z.string(),
      zipCode: z.string(),
      country: z.string(),
    })
    .optional(),
  paymentMethod: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("credit_card"),
      cardNumber: z.string().regex(/^\d{4}$/), // last 4 digits only
      cardBrand: z.enum(["visa", "mastercard", "amex", "discover"]),
    }),
    z.object({
      type: z.literal("paypal"),
      paypalEmail: z.string().email(),
    }),
    z.object({
      type: z.literal("bank_transfer"),
      accountNumber: z.string(),
      routingNumber: z.string(),
    }),
  ]),
  orderStatus: z
    .enum(["pending", "processing", "shipped", "delivered", "cancelled"])
    .default("pending"),
  createdAt: z.string().datetime(),
  notes: z.string().optional(),
});

export const complexOrderTask = schemaTask({
  id: "complex-order-task",
  schema: orderSchema,
  run: async (payload, { ctx }) => {
    // Deep nested type inference
    const orderId = payload.orderId;
    const firstItem = payload.items[0];
    const productName = firstItem.productName;
    const quantity = firstItem.quantity;

    // Calculate totals with full type safety
    const subtotal = payload.items.reduce((sum, item) => {
      const itemTotal = item.quantity * item.unitPrice;
      const discount = itemTotal * (item.discount / 100);
      return sum + (itemTotal - discount);
    }, 0);

    // Discriminated union handling
    let paymentSummary: string;
    switch (payload.paymentMethod.type) {
      case "credit_card":
        paymentSummary = `${payload.paymentMethod.cardBrand} ending in ${payload.paymentMethod.cardNumber}`;
        break;
      case "paypal":
        paymentSummary = `PayPal (${payload.paymentMethod.paypalEmail})`;
        break;
      case "bank_transfer":
        paymentSummary = `Bank transfer ending in ${payload.paymentMethod.accountNumber.slice(-4)}`;
        break;
    }

    // Optional field handling
    const hasBillingAddress = !!payload.billingAddress;
    const billingCity = payload.billingAddress?.city ?? payload.shippingAddress.city;

    return {
      orderId,
      customerId: payload.customerId,
      itemCount: payload.items.length,
      subtotal,
      status: payload.orderStatus,
      paymentSummary,
      shippingCity: payload.shippingAddress.city,
      billingCity,
      hasBillingAddress,
      hasNotes: !!payload.notes,
    };
  },
});

// Test 5: Task trigger type safety
export const testTriggerTypeSafety = task({
  id: "test-trigger-type-safety",
  run: async (_, { ctx }) => {
    console.log("Testing trigger type safety...");

    // Valid trigger - should compile
    const handle1 = await zodSchemaTask.trigger({
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userName: "John Doe",
      userEmail: "john@example.com",
      age: 30,
      preferences: {
        theme: "dark",
        notifications: false,
        language: "es",
      },
      tags: ["customer", "premium"],
      createdAt: new Date().toISOString(),
    });

    // Using defaults - should also compile
    const handle2 = await zodSchemaTask.trigger({
      userId: "550e8400-e29b-41d4-a716-446655440001",
      userName: "Jane Smith",
      userEmail: "jane@example.com",
      age: 25,
      preferences: {}, // Will use defaults
      // tags will default to []
    });

    // Test triggerAndWait with result handling
    const result = await zodSchemaTask.triggerAndWait({
      userId: "550e8400-e29b-41d4-a716-446655440002",
      userName: "Bob Wilson",
      userEmail: "bob@example.com",
      age: 45,
      preferences: {
        theme: "light",
      },
    });

    if (result.ok) {
      // Type-safe access to output
      console.log("Processed user:", result.output.processedUserName);
      console.log("User email:", result.output.processedUserEmail);
      console.log("Theme:", result.output.theme);

      return {
        success: true,
        processedUserId: result.output.processedUserId,
        userName: result.output.processedUserName,
      };
    } else {
      return {
        success: false,
        error: String(result.error),
      };
    }
  },
});

// Test 6: Batch operations with type safety
export const testBatchOperations = task({
  id: "test-batch-operations",
  run: async (_, { ctx }) => {
    console.log("Testing batch operations...");

    // Batch trigger
    const batchHandle = await zodSchemaTask.batchTrigger([
      {
        payload: {
          userId: "batch-001",
          userName: "Batch User 1",
          userEmail: "batch1@example.com",
          age: 20,
          preferences: {
            theme: "dark",
          },
        },
      },
      {
        payload: {
          userId: "batch-002",
          userName: "Batch User 2",
          userEmail: "batch2@example.com",
          age: 30,
          preferences: {
            theme: "light",
            notifications: false,
          },
          tags: ["batch", "test"],
        },
      },
    ]);

    console.log(`Triggered batch ${batchHandle.batchId} with ${batchHandle.runCount} runs`);

    // Batch trigger and wait
    const batchResult = await zodSchemaTask.batchTriggerAndWait([
      {
        payload: {
          userId: "batch-003",
          userName: "Batch User 3",
          userEmail: "batch3@example.com",
          age: 40,
          preferences: {},
        },
      },
      {
        payload: {
          userId: "batch-004",
          userName: "Batch User 4",
          userEmail: "batch4@example.com",
          age: 50,
          preferences: {
            language: "fr",
          },
          tags: ["batch", "wait"],
        },
      },
    ]);

    // Process results with type safety
    const processed = batchResult.runs.map((run) => {
      if (run.ok) {
        return {
          success: true,
          userId: run.output.processedUserId,
          userName: run.output.processedUserName,
          theme: run.output.theme,
        };
      } else {
        return {
          success: false,
          runId: run.id,
          error: String(run.error),
        };
      }
    });

    return {
      batchId: batchResult.id,
      totalRuns: batchResult.runs.length,
      successfulRuns: processed.filter((p) => p.success).length,
      processed,
    };
  },
});

// Test 7: Integration test - all features together
export const integrationTest = task({
  id: "json-schema-integration-test",
  run: async (_, { ctx }) => {
    console.log("Running integration test...");

    const results = {
      plainTask: false,
      zodTask: false,
      complexTask: false,
      triggerTypes: false,
      batchOps: false,
    };

    try {
      // Test plain JSON schema task
      const plainResult = await plainJsonSchemaTask.trigger({
        id: "test-001",
        name: "Test User",
        email: "test@example.com",
        active: true,
        score: 85,
        tags: ["test"],
        metadata: { source: "integration-test" },
      });
      results.plainTask = !!plainResult.id;

      // Test Zod schema task
      const zodResult = await zodSchemaTask
        .triggerAndWait({
          userId: "int-test-001",
          userName: "Integration Test User",
          userEmail: "integration@example.com",
          age: 35,
          preferences: {
            theme: "auto",
          },
        })
        .unwrap();
      results.zodTask = zodResult.processedUserId === "int-test-001";

      // Test complex schema
      const complexResult = await complexOrderTask.trigger({
        orderId: "order-int-001",
        customerId: "cust-int-001",
        items: [
          {
            productId: "prod-001",
            productName: "Test Product",
            quantity: 2,
            unitPrice: 29.99,
            discount: 10,
          },
        ],
        shippingAddress: {
          street: "123 Test St",
          city: "Test City",
          state: "TC",
          zipCode: "12345",
        },
        paymentMethod: {
          type: "credit_card",
          cardNumber: "1234",
          cardBrand: "visa",
        },
        createdAt: new Date().toISOString(),
      });
      results.complexTask = !!complexResult.id;

      // Test trigger type safety
      const triggerResult = await testTriggerTypeSafety.triggerAndWait(undefined);
      results.triggerTypes = triggerResult.ok && triggerResult.output.success;

      // Test batch operations
      const batchResult = await testBatchOperations.triggerAndWait(undefined);
      results.batchOps = batchResult.ok && batchResult.output.successfulRuns > 0;
    } catch (error) {
      console.error("Integration test error:", error);
    }

    const allPassed = Object.values(results).every((r) => r);

    return {
      success: allPassed,
      results,
      message: allPassed ? "All JSON schema tests passed!" : "Some tests failed - check results",
    };
  },
});
