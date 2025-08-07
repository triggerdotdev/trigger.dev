import { task, schemaTask, logger, type JSONSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// ===========================================
// Example: Webhook Handler with Schema Validation
// ===========================================

// Define schemas for different webhook event types
const baseWebhookSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  type: z.string(),
  version: z.literal("1.0"),
});

// Payment webhook events
const paymentEventSchema = baseWebhookSchema.extend({
  type: z.literal("payment"),
  data: z.object({
    paymentId: z.string(),
    amount: z.number().positive(),
    currency: z.string().length(3),
    status: z.enum(["pending", "processing", "completed", "failed"]),
    customerId: z.string(),
    paymentMethod: z.object({
      type: z.enum(["card", "bank_transfer", "paypal"]),
      last4: z.string().optional(),
    }),
    metadata: z.record(z.string()).optional(),
  }),
});

// Customer webhook events
const customerEventSchema = baseWebhookSchema.extend({
  type: z.literal("customer"),
  data: z.object({
    customerId: z.string(),
    action: z.enum(["created", "updated", "deleted"]),
    email: z.string().email(),
    name: z.string(),
    subscription: z.object({
      status: z.enum(["active", "cancelled", "past_due"]),
      plan: z.string(),
    }).optional(),
  }),
});

// Union of all webhook types
const webhookSchema = z.discriminatedUnion("type", [
  paymentEventSchema,
  customerEventSchema,
]);

export const handleWebhook = schemaTask({
  id: "handle-webhook",
  schema: webhookSchema,
  run: async (payload, { ctx }) => {
    logger.info("Processing webhook", { 
      id: payload.id,
      type: payload.type,
      timestamp: payload.timestamp,
    });

    // TypeScript knows the exact shape based on the discriminated union
    switch (payload.type) {
      case "payment":
        logger.info("Payment event received", {
          paymentId: payload.data.paymentId,
          amount: payload.data.amount,
          status: payload.data.status,
        });

        if (payload.data.status === "completed") {
          // Trigger order fulfillment
          await fulfillOrder.trigger({
            customerId: payload.data.customerId,
            paymentId: payload.data.paymentId,
            amount: payload.data.amount,
          });
        }
        break;

      case "customer":
        logger.info("Customer event received", {
          customerId: payload.data.customerId,
          action: payload.data.action,
        });

        if (payload.data.action === "created") {
          // Send welcome email
          await sendWelcomeEmail.trigger({
            email: payload.data.email,
            name: payload.data.name,
          });
        }
        break;
    }

    return {
      processed: true,
      eventId: payload.id,
      eventType: payload.type,
    };
  },
});

// ===========================================
// Example: External API Integration
// ===========================================

// Schema for making API requests to a third-party service
const apiRequestSchema = z.object({
  endpoint: z.enum(["/users", "/products", "/orders"]),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  params: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string()).optional(),
  retryOnError: z.boolean().default(true),
});

// Response schemas for different endpoints
const userResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.string().datetime(),
});

const productResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  inStock: z.boolean(),
});

export const callExternalApi = schemaTask({
  id: "call-external-api",
  schema: apiRequestSchema,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
  },
  run: async (payload, { ctx }) => {
    logger.info("Making API request", {
      endpoint: payload.endpoint,
      method: payload.method,
    });

    // Simulate API call
    const response = await makeApiCall(payload);

    // Validate response based on endpoint
    let validatedResponse;
    switch (payload.endpoint) {
      case "/users":
        validatedResponse = userResponseSchema.parse(response);
        break;
      case "/products":
        validatedResponse = productResponseSchema.parse(response);
        break;
      default:
        validatedResponse = response;
    }

    return {
      success: true,
      endpoint: payload.endpoint,
      response: validatedResponse,
    };
  },
});

// Helper function to simulate API calls
async function makeApiCall(request: z.infer<typeof apiRequestSchema>) {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 100));

  // Return mock data based on endpoint
  switch (request.endpoint) {
    case "/users":
      return {
        id: "user_123",
        email: "user@example.com",
        name: "John Doe",
        createdAt: new Date().toISOString(),
      };
    case "/products":
      return {
        id: "prod_456",
        name: "Premium Widget",
        price: 99.99,
        inStock: true,
      };
    default:
      return { message: "Success" };
  }
}

// ===========================================
// Example: Batch Processing with Validation
// ===========================================

const batchItemSchema = z.object({
  id: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  resourceType: z.enum(["user", "product", "order"]),
  data: z.record(z.unknown()),
});

const batchRequestSchema = z.object({
  batchId: z.string(),
  items: z.array(batchItemSchema).min(1).max(100),
  options: z.object({
    stopOnError: z.boolean().default(false),
    parallel: z.boolean().default(true),
    maxConcurrency: z.number().int().min(1).max(10).default(5),
  }).default({}),
});

export const processBatch = schemaTask({
  id: "process-batch",
  schema: batchRequestSchema,
  maxDuration: 300, // 5 minutes for large batches
  run: async (payload, { ctx }) => {
    logger.info("Processing batch", {
      batchId: payload.batchId,
      itemCount: payload.items.length,
      parallel: payload.options.parallel,
    });

    const results = [];
    const errors = [];

    if (payload.options.parallel) {
      // Process items in parallel with concurrency limit
      const chunks = chunkArray(payload.items, payload.options.maxConcurrency);
      
      for (const chunk of chunks) {
        const chunkResults = await Promise.allSettled(
          chunk.map(item => processItem(item))
        );

        chunkResults.forEach((result, index) => {
          if (result.status === "fulfilled") {
            results.push(result.value);
          } else {
            errors.push({
              item: chunk[index],
              error: result.reason,
            });

            if (payload.options.stopOnError) {
              throw new Error(`Batch processing stopped due to error in item ${chunk[index].id}`);
            }
          }
        });
      }
    } else {
      // Process items sequentially
      for (const item of payload.items) {
        try {
          const result = await processItem(item);
          results.push(result);
        } catch (error) {
          errors.push({ item, error });

          if (payload.options.stopOnError) {
            throw new Error(`Batch processing stopped due to error in item ${item.id}`);
          }
        }
      }
    }

    return {
      batchId: payload.batchId,
      processed: results.length,
      failed: errors.length,
      results,
      errors,
    };
  },
});

async function processItem(item: z.infer<typeof batchItemSchema>) {
  logger.info("Processing batch item", {
    id: item.id,
    operation: item.operation,
    resourceType: item.resourceType,
  });

  // Simulate processing
  await new Promise(resolve => setTimeout(resolve, 50));

  return {
    id: item.id,
    success: true,
    operation: item.operation,
    resourceType: item.resourceType,
  };
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ===========================================
// Helper Tasks
// ===========================================

const orderSchema = z.object({
  customerId: z.string(),
  paymentId: z.string(),
  amount: z.number(),
});

export const fulfillOrder = schemaTask({
  id: "fulfill-order",
  schema: orderSchema,
  run: async (payload, { ctx }) => {
    logger.info("Fulfilling order", payload);
    return { fulfilled: true };
  },
});

const welcomeEmailSchema = z.object({
  email: z.string().email(),
  name: z.string(),
});

export const sendWelcomeEmail = schemaTask({
  id: "send-welcome-email",
  schema: welcomeEmailSchema,
  run: async (payload, { ctx }) => {
    logger.info("Sending welcome email", payload);
    return { sent: true };
  },
});