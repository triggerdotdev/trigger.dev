import { task, schemaTask, logger, type JSONSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import * as y from "yup";
import { type } from "arktype";
import { Type, Static } from "@sinclair/typebox";

// ===========================================
// Example 1: Using schemaTask with Zod
// ===========================================
const userSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
  preferences: z.object({
    newsletter: z.boolean().default(false),
    theme: z.enum(["light", "dark"]).default("light"),
  }).optional(),
});

export const processUserWithZod = schemaTask({
  id: "json-schema-zod-example",
  schema: userSchema,
  run: async (payload, { ctx }) => {
    // payload is fully typed based on the Zod schema
    logger.info("Processing user with Zod schema", { 
      userId: payload.id, 
      userName: payload.name 
    });

    // The schema is automatically converted to JSON Schema and synced
    return {
      processed: true,
      userId: payload.id,
      welcomeMessage: `Welcome ${payload.name}!`,
    };
  },
});

// ===========================================
// Example 2: Using plain task with manual JSON Schema
// ===========================================
export const processOrderManualSchema = task({
  id: "json-schema-manual-example",
  // Manually provide JSON Schema for the payload
  payloadSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: "Order Processing Request",
    description: "Schema for processing customer orders",
    properties: {
      orderId: { 
        type: "string", 
        pattern: "^ORD-[0-9]+$",
        description: "Order ID in format ORD-XXXXX"
      },
      customerId: { 
        type: "string", 
        format: "uuid" 
      },
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            productId: { type: "string" },
            quantity: { type: "integer", minimum: 1 },
            price: { type: "number", minimum: 0, multipleOf: 0.01 },
          },
          required: ["productId", "quantity", "price"],
          additionalProperties: false,
        },
      },
      totalAmount: { 
        type: "number", 
        minimum: 0,
        multipleOf: 0.01,
      },
      status: {
        type: "string",
        enum: ["pending", "processing", "shipped", "delivered"],
        default: "pending",
      },
    },
    required: ["orderId", "customerId", "items", "totalAmount"],
    additionalProperties: false,
  } satisfies JSONSchema,
  run: async (payload, { ctx }) => {
    logger.info("Processing order with manual JSON Schema", { 
      orderId: payload.orderId 
    });

    // Note: With plain tasks, the payload is typed as 'any'
    // The JSON Schema will be used for documentation and validation on the server
    return {
      processed: true,
      orderId: payload.orderId,
      status: "processing",
    };
  },
});

// ===========================================
// Example 3: Using schemaTask with Yup
// ===========================================
const productSchema = y.object({
  sku: y.string().required().matches(/^[A-Z]{3}-[0-9]{5}$/),
  name: y.string().required().min(3).max(100),
  description: y.string().max(500),
  price: y.number().required().positive(),
  categories: y.array().of(y.string()).min(1).required(),
  inStock: y.boolean().default(true),
});

export const processProductWithYup = schemaTask({
  id: "json-schema-yup-example",
  schema: productSchema,
  run: async (payload, { ctx }) => {
    logger.info("Processing product with Yup schema", { 
      sku: payload.sku,
      name: payload.name,
    });

    return {
      processed: true,
      sku: payload.sku,
      message: `Product ${payload.name} has been processed`,
    };
  },
});

// ===========================================
// Example 4: Using schemaTask with ArkType
// ===========================================
const invoiceSchema = type({
  invoiceNumber: "string",
  date: "Date",
  dueDate: "Date",
  "discount?": "number",
  lineItems: [{
    description: "string",
    quantity: "integer",
    unitPrice: "number",
  }],
  customer: {
    id: "string",
    name: "string",
    "taxId?": "string",
  },
});

export const processInvoiceWithArkType = schemaTask({
  id: "json-schema-arktype-example",
  schema: invoiceSchema,
  run: async (payload, { ctx }) => {
    logger.info("Processing invoice with ArkType schema", { 
      invoiceNumber: payload.invoiceNumber,
      customerName: payload.customer.name,
    });

    const total = payload.lineItems.reduce(
      (sum, item) => sum + (item.quantity * item.unitPrice),
      0
    );

    const discount = payload.discount || 0;
    const finalAmount = total * (1 - discount / 100);

    return {
      processed: true,
      invoiceNumber: payload.invoiceNumber,
      totalAmount: finalAmount,
    };
  },
});

// ===========================================
// Example 5: Using TypeBox (already JSON Schema)
// ===========================================
const eventSchema = Type.Object({
  eventId: Type.String({ format: "uuid" }),
  eventType: Type.Union([
    Type.Literal("user.created"),
    Type.Literal("user.updated"),
    Type.Literal("user.deleted"),
    Type.Literal("order.placed"),
    Type.Literal("order.shipped"),
  ]),
  timestamp: Type.Integer({ minimum: 0 }),
  userId: Type.String(),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  payload: Type.Unknown(),
});

type EventType = Static<typeof eventSchema>;

export const processEventWithTypeBox = task({
  id: "json-schema-typebox-example",
  // TypeBox schemas are already JSON Schema compliant
  payloadSchema: eventSchema,
  run: async (payload, { ctx }) => {
    // Cast to get TypeScript type safety
    const event = payload as EventType;
    
    logger.info("Processing event with TypeBox schema", { 
      eventId: event.eventId,
      eventType: event.eventType,
      userId: event.userId,
    });

    // Handle different event types
    switch (event.eventType) {
      case "user.created":
        logger.info("New user created", { userId: event.userId });
        break;
      case "order.placed":
        logger.info("Order placed", { userId: event.userId });
        break;
      default:
        logger.info("Event processed", { eventType: event.eventType });
    }

    return {
      processed: true,
      eventId: event.eventId,
      eventType: event.eventType,
    };
  },
});

// ===========================================
// Example 6: Using plain task with a Zod schema
// ===========================================
// If you need to use a plain task but have a Zod schema,
// you should use schemaTask instead for better DX.
// This example shows what NOT to do:

const notificationSchema = z.object({
  recipientId: z.string(),
  type: z.enum(["email", "sms", "push"]),
  subject: z.string().optional(),
  message: z.string(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  scheduledFor: z.date().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ❌ Don't do this - use schemaTask instead!
export const sendNotificationBadExample = task({
  id: "json-schema-dont-do-this",
  run: async (payload, { ctx }) => {
    // You'd have to manually validate
    const notification = notificationSchema.parse(payload);
    
    logger.info("This is not ideal - use schemaTask instead!");

    return { sent: true };
  },
});

// ✅ Do this instead - much better!
export const sendNotificationGoodExample = schemaTask({
  id: "json-schema-do-this-instead",
  schema: notificationSchema,
  run: async (notification, { ctx }) => {
    // notification is already validated and typed!
    logger.info("Sending notification", { 
      recipientId: notification.recipientId,
      type: notification.type,
      priority: notification.priority,
    });

    // Simulate sending notification
    await new Promise(resolve => setTimeout(resolve, 1000));

    return {
      sent: true,
      notificationId: ctx.run.id,
      recipientId: notification.recipientId,
      type: notification.type,
    };
  },
});

// ===========================================
// Example 7: Complex nested schema with references
// ===========================================
const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
  state: z.string().length(2),
  zipCode: z.string().regex(/^\d{5}(-\d{4})?$/),
  country: z.string().default("US"),
});

const companySchema = z.object({
  companyId: z.string().uuid(),
  name: z.string(),
  taxId: z.string().optional(),
  addresses: z.object({
    billing: addressSchema,
    shipping: addressSchema.optional(),
  }),
  contacts: z.array(z.object({
    name: z.string(),
    email: z.string().email(),
    phone: z.string().optional(),
    role: z.enum(["primary", "billing", "technical"]),
  })).min(1),
  settings: z.object({
    invoicePrefix: z.string().default("INV"),
    paymentTerms: z.number().int().min(0).max(90).default(30),
    currency: z.enum(["USD", "EUR", "GBP"]).default("USD"),
  }),
});

export const processCompanyWithComplexSchema = schemaTask({
  id: "json-schema-complex-example",
  schema: companySchema,
  maxDuration: 300, // 5 minutes
  retry: {
    maxAttempts: 3,
    factor: 2,
  },
  run: async (payload, { ctx }) => {
    logger.info("Processing company with complex schema", { 
      companyId: payload.companyId,
      name: payload.name,
      contactCount: payload.contacts.length,
    });

    // Process each contact
    for (const contact of payload.contacts) {
      logger.info("Processing contact", { 
        name: contact.name,
        role: contact.role,
      });
    }

    return {
      processed: true,
      companyId: payload.companyId,
      name: payload.name,
      primaryContact: payload.contacts.find(c => c.role === "primary"),
    };
  },
});

// ===========================================
// Example 8: Demonstrating schema benefits
// ===========================================
export const triggerExamples = task({
  id: "json-schema-trigger-examples",
  run: async (_, { ctx }) => {
    logger.info("Triggering various schema examples");

    // Trigger Zod example - TypeScript will enforce correct payload
    await processUserWithZod.trigger({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "John Doe",
      email: "john@example.com",
      age: 30,
      preferences: {
        newsletter: true,
        theme: "dark",
      },
    });

    // Trigger Yup example
    await processProductWithYup.trigger({
      sku: "ABC-12345",
      name: "Premium Widget",
      description: "A high-quality widget for all your needs",
      price: 99.99,
      categories: ["electronics", "gadgets"],
      inStock: true,
    });

    // Trigger manual schema example (no compile-time validation)
    await processOrderManualSchema.trigger({
      orderId: "ORD-12345",
      customerId: "550e8400-e29b-41d4-a716-446655440001",
      items: [
        {
          productId: "PROD-001",
          quantity: 2,
          price: 29.99,
        },
        {
          productId: "PROD-002",
          quantity: 1,
          price: 49.99,
        },
      ],
      totalAmount: 109.97,
      status: "pending",
    });

    return {
      message: "All examples triggered successfully",
      timestamp: new Date().toISOString(),
    };
  },
});