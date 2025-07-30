import { schemaTask, task, type JSONSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// Test 1: Basic Zod schema with schemaTask
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
  isActive: z.boolean(),
  roles: z.array(z.enum(["admin", "user", "guest"])),
  metadata: z.record(z.unknown()).optional(),
});

export const zodSchemaTask = schemaTask({
  id: "zod-schema-task",
  schema: userSchema,
  run: async (payload, { ctx }) => {
    // Type checking: payload should be fully typed
    const id: string = payload.id;
    const name: string = payload.name;
    const email: string = payload.email;
    const age: number = payload.age;
    const isActive: boolean = payload.isActive;
    const roles: ("admin" | "user" | "guest")[] = payload.roles;
    const metadata: Record<string, unknown> | undefined = payload.metadata;

    return {
      processed: true,
      userId: payload.id,
      userName: payload.name,
    };
  },
});

// Test 2: Complex nested Zod schema
const complexSchema = z.object({
  order: z.object({
    orderId: z.string().uuid(),
    items: z.array(
      z.object({
        productId: z.string(),
        quantity: z.number().positive(),
        price: z.number().positive(),
        discount: z.number().min(0).max(100).optional(),
      })
    ),
    customer: z.object({
      customerId: z.string(),
      email: z.string().email(),
      shippingAddress: z.object({
        street: z.string(),
        city: z.string(),
        state: z.string().length(2),
        zipCode: z.string().regex(/^\d{5}(-\d{4})?$/),
        country: z.string().default("US"),
      }),
    }),
    paymentMethod: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("credit_card"),
        last4: z.string().length(4),
        brand: z.enum(["visa", "mastercard", "amex"]),
      }),
      z.object({
        type: z.literal("paypal"),
        email: z.string().email(),
      }),
    ]),
    createdAt: z.string().datetime(),
    status: z.enum(["pending", "processing", "shipped", "delivered", "cancelled"]),
  }),
  notes: z.string().optional(),
  priority: z.number().int().min(1).max(5).default(3),
});

export const complexZodTask = schemaTask({
  id: "complex-zod-task",
  schema: complexSchema,
  run: async (payload, { ctx }) => {
    // Test type inference on nested properties
    const orderId: string = payload.order.orderId;
    const firstItem = payload.order.items[0];
    const quantity: number = firstItem.quantity;
    const customerEmail: string = payload.order.customer.email;
    const zipCode: string = payload.order.customer.shippingAddress.zipCode;

    // Discriminated union type checking
    if (payload.order.paymentMethod.type === "credit_card") {
      const brand: "visa" | "mastercard" | "amex" = payload.order.paymentMethod.brand;
      const last4: string = payload.order.paymentMethod.last4;
    } else {
      const paypalEmail: string = payload.order.paymentMethod.email;
    }

    return {
      orderId: payload.order.orderId,
      itemCount: payload.order.items.length,
      status: payload.order.status,
    };
  },
});

// Test 3: Plain task with manual JSON schema
const manualJsonSchema: JSONSchema = {
  type: "object",
  properties: {
    taskId: { type: "string", pattern: "^task_[a-zA-Z0-9]+$" },
    priority: { type: "integer", minimum: 1, maximum: 10 },
    tags: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 5,
    },
    config: {
      type: "object",
      properties: {
        timeout: { type: "number" },
        retries: { type: "integer", minimum: 0 },
        async: { type: "boolean" },
      },
      required: ["timeout", "retries"],
    },
  },
  required: ["taskId", "priority"],
  additionalProperties: false,
};

export const plainJsonSchemaTask = task({
  id: "plain-json-schema-task",
  jsonSchema: manualJsonSchema,
  run: async (payload, { ctx }) => {
    // With plain task, payload is 'any' so we need to manually type it
    const taskId = payload.taskId as string;
    const priority = payload.priority as number;
    const tags = payload.tags as string[] | undefined;
    const config = payload.config as
      | { timeout: number; retries: number; async?: boolean }
      | undefined;

    return {
      processed: true,
      taskId,
      priority,
      hasConfig: !!config,
    };
  },
});

// Test 4: Testing trigger type safety
export const testTriggerTypeSafety = task({
  id: "test-trigger-type-safety",
  run: async (_, { ctx }) => {
    // This should compile successfully with proper types
    const result1 = await zodSchemaTask.trigger({
      id: "user123",
      name: "John Doe",
      email: "john@example.com",
      age: 30,
      isActive: true,
      roles: ["user", "admin"],
    });

    // This should show TypeScript errors if uncommented:
    // const result2 = await zodSchemaTask.trigger({
    //   id: "user123",
    //   name: "John Doe",
    //   email: "not-an-email", // Invalid email
    //   age: "thirty", // Wrong type
    //   isActive: "yes", // Wrong type
    //   roles: ["superuser"], // Invalid enum value
    // });

    // Test complex schema trigger
    const result3 = await complexZodTask.trigger({
      order: {
        orderId: "550e8400-e29b-41d4-a716-446655440000",
        items: [
          {
            productId: "prod123",
            quantity: 2,
            price: 29.99,
            discount: 10,
          },
        ],
        customer: {
          customerId: "cust456",
          email: "customer@example.com",
          shippingAddress: {
            street: "123 Main St",
            city: "Anytown",
            state: "CA",
            zipCode: "12345",
            country: "US",
          },
        },
        paymentMethod: {
          type: "credit_card",
          last4: "1234",
          brand: "visa",
        },
        createdAt: new Date().toISOString(),
        status: "pending",
      },
      priority: 5,
    });

    return {
      triggered: true,
      runIds: [result1.id, result3.id],
    };
  },
});

// Test 5: Testing triggerAndWait with proper unwrap
export const testTriggerAndWait = task({
  id: "test-trigger-and-wait",
  run: async (_, { ctx }) => {
    // Test type inference with triggerAndWait
    const result = await zodSchemaTask.triggerAndWait({
      id: "user456",
      name: "Jane Smith",
      email: "jane@example.com",
      age: 25,
      isActive: false,
      roles: ["guest"],
      metadata: {
        source: "api",
        version: "1.0",
      },
    });

    if (result.ok) {
      // result.output should be typed
      const processed: boolean = result.output.processed;
      const userId: string = result.output.userId;
      const userName: string = result.output.userName;

      return {
        success: true,
        processedUserId: userId,
        processedUserName: userName,
      };
    } else {
      return {
        success: false,
        error: String(result.error),
      };
    }
  },
});

// Test 6: Using unwrap() method
export const testUnwrap = task({
  id: "test-unwrap",
  run: async (_, { ctx }) => {
    try {
      // Using unwrap() for cleaner code
      const output = await zodSchemaTask
        .triggerAndWait({
          id: "user789",
          name: "Bob Johnson",
          email: "bob@example.com",
          age: 35,
          isActive: true,
          roles: ["user"],
        })
        .unwrap();

      // output is directly typed without needing to check result.ok
      const processed: boolean = output.processed;
      const userId: string = output.userId;
      const userName: string = output.userName;

      return {
        unwrapped: true,
        userId,
        userName,
      };
    } catch (error) {
      return {
        unwrapped: false,
        error: String(error),
      };
    }
  },
});