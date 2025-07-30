import { schemaTask } from "@trigger.dev/sdk";
import { Type } from "@sinclair/typebox";
import {
  array,
  object,
  string,
  number,
  boolean,
  optional,
  union,
  literal,
  record,
  Infer,
} from "superstruct";
import * as S from "@effect/schema/Schema";
import { type } from "arktype";
import * as v from "valibot";
import * as rt from "runtypes";

// Test TypeBox schema
const typeBoxSchema = Type.Object({
  id: Type.String({ pattern: "^[a-zA-Z0-9]+$" }),
  title: Type.String({ minLength: 1, maxLength: 100 }),
  content: Type.String({ minLength: 10 }),
  author: Type.Object({
    name: Type.String(),
    email: Type.String({ format: "email" }),
    role: Type.Union([Type.Literal("admin"), Type.Literal("editor"), Type.Literal("viewer")]),
  }),
  tags: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
  published: Type.Boolean(),
  publishedAt: Type.Optional(Type.String({ format: "date-time" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const typeBoxTask = schemaTask({
  id: "typebox-schema-task",
  schema: typeBoxSchema,
  run: async (payload, { ctx }) => {
    // TypeBox provides static type inference
    const id: string = payload.id;
    const title: string = payload.title;
    const authorEmail: string = payload.author.email;
    const role: "admin" | "editor" | "viewer" = payload.author.role;
    const tagCount = payload.tags.length;
    const isPublished: boolean = payload.published;

    return {
      documentId: id,
      title,
      authorEmail,
      role,
      tagCount,
      status: isPublished ? "published" : "draft",
    };
  },
});

// Test Superstruct schema
const superstructSchema = object({
  transaction: object({
    id: string(),
    amount: number(),
    currency: union([literal("USD"), literal("EUR"), literal("GBP")]),
    type: union([literal("credit"), literal("debit")]),
    description: optional(string()),
    tags: optional(array(string())),
    metadata: optional(record(string(), string())),
  }),
  account: object({
    accountId: string(),
    balance: number(),
    overdraftLimit: optional(number()),
  }),
  timestamp: string(),
  approved: boolean(),
});

type SuperstructTransaction = Infer<typeof superstructSchema>;

export const superstructTask = schemaTask({
  id: "superstruct-schema-task",
  schema: superstructSchema,
  run: async (payload: SuperstructTransaction, { ctx }) => {
    // Superstruct infers types correctly
    const transactionId = payload.transaction.id;
    const amount = payload.transaction.amount;
    const currency = payload.transaction.currency;
    const accountBalance = payload.account.balance;
    const isApproved = payload.approved;

    const newBalance =
      payload.transaction.type === "credit" ? accountBalance + amount : accountBalance - amount;

    return {
      transactionId,
      processedAt: new Date().toISOString(),
      newBalance,
      currency,
      approved: isApproved,
      requiresReview: newBalance < 0 && !payload.account.overdraftLimit,
    };
  },
});

// Test Effect Schema
const effectSchema = S.Struct({
  event: S.Struct({
    eventId: S.String,
    eventType: S.Literal("click", "view", "purchase"),
    timestamp: S.Date,
    sessionId: S.String,
  }),
  user: S.Struct({
    userId: S.String,
    email: S.String,
  }),
  product: S.optional(
    S.Struct({
      productId: S.String,
      name: S.String,
      price: S.Number,
      category: S.String,
    })
  ),
  location: S.optional(
    S.Struct({
      country: S.String,
      city: S.optional(S.String),
      region: S.optional(S.String),
    })
  ),
});

type EffectEvent = S.Schema.Type<typeof effectSchema>;

export const effectSchemaTask = schemaTask({
  id: "effect-schema-task",
  schema: effectSchema,
  run: async (payload, { ctx }) => {
    // Effect Schema provides type safety
    const eventId = payload.event.eventId;
    const eventType = payload.event.eventType;
    const userId = payload.user.userId;
    const hasProduct = !!payload.product;
    const productName = payload.product?.name;
    const country = payload.location?.country;

    return {
      eventId,
      eventType,
      userId,
      hasProduct,
      productName,
      country: country ?? "unknown",
      processed: true,
    };
  },
});

// Test ArkType schema
const arkTypeSchema = type({
  request: {
    method: "'GET' | 'POST' | 'PUT' | 'DELETE'",
    path: "string",
    headers: "Record<string, string>",
    "body?": "unknown",
    "query?": "Record<string, string>",
  },
  response: {
    status: "number",
    "headers?": "Record<string, string>",
    "body?": "unknown",
  },
  timing: {
    start: "Date",
    end: "Date",
    duration: "number",
  },
  "metadata?": {
    "ip?": "string",
    "userAgent?": "string",
    "referer?": "string",
  },
});

export const arkTypeTask = schemaTask({
  id: "arktype-schema-task",
  schema: arkTypeSchema,
  run: async (payload, { ctx }) => {
    // ArkType infers types
    const method = payload.request.method;
    const path = payload.request.path;
    const status = payload.response.status;
    const duration = payload.timing.duration;
    const hasBody = !!payload.request.body;
    const userAgent = payload.metadata?.userAgent;

    return {
      logId: `log_${ctx.run.id}`,
      method,
      path,
      status,
      duration,
      hasBody,
      userAgent: userAgent ?? "unknown",
      success: status >= 200 && status < 300,
    };
  },
});

// Test Valibot schema
const valibotSchema = v.object({
  form: v.object({
    name: v.pipe(v.string(), v.minLength(2), v.maxLength(50)),
    email: v.pipe(v.string(), v.email()),
    age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(150)),
    website: v.optional(v.pipe(v.string(), v.url())),
    bio: v.optional(v.pipe(v.string(), v.maxLength(500))),
    interests: v.array(v.string()),
    preferences: v.object({
      theme: v.union([v.literal("light"), v.literal("dark"), v.literal("auto")]),
      notifications: v.boolean(),
      language: v.string(),
    }),
  }),
  submittedAt: v.string(),
  source: v.union([v.literal("web"), v.literal("mobile"), v.literal("api")]),
});

type ValibotForm = v.InferOutput<typeof valibotSchema>;

export const valibotTask = schemaTask({
  id: "valibot-schema-task",
  schema: valibotSchema,
  run: async (payload: ValibotForm, { ctx }) => {
    // Valibot provides type inference
    const name = payload.form.name;
    const email = payload.form.email;
    const age = payload.form.age;
    const hasWebsite = !!payload.form.website;
    const theme = payload.form.preferences.theme;
    const source = payload.source;

    return {
      submissionId: `sub_${ctx.run.id}`,
      name,
      email,
      age,
      hasWebsite,
      theme,
      source,
      processed: true,
    };
  },
});

// Test Runtypes schema
const runtypesSchema = rt.Record({
  payment: rt.Record({
    paymentId: rt.String,
    amount: rt.Number,
    currency: rt.Union(rt.Literal("USD"), rt.Literal("EUR"), rt.Literal("GBP")),
    method: rt.Union(
      rt.Record({
        type: rt.Literal("card"),
        last4: rt.String,
        brand: rt.String,
      }),
      rt.Record({
        type: rt.Literal("bank"),
        accountNumber: rt.String,
        routingNumber: rt.String,
      })
    ),
    status: rt.Union(
      rt.Literal("pending"),
      rt.Literal("processing"),
      rt.Literal("completed"),
      rt.Literal("failed")
    ),
  }),
  customer: rt.Record({
    customerId: rt.String,
    email: rt.String,
    name: rt.String,
  }),
  metadata: rt.Optional(rt.Dictionary(rt.Unknown)),
});

type RuntypesPayment = rt.Static<typeof runtypesSchema>;

export const runtypesTask = schemaTask({
  id: "runtypes-schema-task",
  schema: runtypesSchema,
  run: async (payload: RuntypesPayment, { ctx }) => {
    // Runtypes provides static types
    const paymentId = payload.payment.paymentId;
    const amount = payload.payment.amount;
    const currency = payload.payment.currency;
    const status = payload.payment.status;
    const customerEmail = payload.customer.email;

    // Discriminated union handling
    const paymentDetails =
      payload.payment.method.type === "card"
        ? `Card ending in ${payload.payment.method.last4}`
        : `Bank account ${payload.payment.method.accountNumber}`;

    return {
      paymentId,
      amount,
      currency,
      status,
      customerEmail,
      paymentDetails,
      requiresAction: status === "pending" || status === "processing",
    };
  },
});

// Test task that triggers all schema tasks
export const testAllSchemas = schemaTask({
  id: "test-all-schemas",
  schema: z.object({ runAll: z.boolean() }),
  run: async (payload, { ctx }) => {
    const results = [];

    // Test TypeBox
    const typeBoxResult = await typeBoxTask.trigger({
      id: "doc123",
      title: "Test Document",
      content: "This is a test document with sufficient content.",
      author: {
        name: "John Doe",
        email: "john@example.com",
        role: "editor",
      },
      tags: ["test", "sample"],
      published: true,
      publishedAt: new Date().toISOString(),
    });
    results.push({ task: "typebox", runId: typeBoxResult.id });

    // Test Superstruct
    const superstructResult = await superstructTask.trigger({
      transaction: {
        id: "txn123",
        amount: 100.5,
        currency: "USD",
        type: "credit",
        description: "Test transaction",
      },
      account: {
        accountId: "acc456",
        balance: 1000,
        overdraftLimit: 500,
      },
      timestamp: new Date().toISOString(),
      approved: true,
    });
    results.push({ task: "superstruct", runId: superstructResult.id });

    // Test Effect Schema
    const effectResult = await effectSchemaTask.trigger({
      event: {
        eventId: "evt789",
        eventType: "purchase",
        timestamp: new Date(),
        sessionId: "sess123",
      },
      user: {
        userId: "user456",
        email: "user@example.com",
      },
      product: {
        productId: "prod789",
        name: "Test Product",
        price: 29.99,
        category: "Electronics",
      },
    });
    results.push({ task: "effect", runId: effectResult.id });

    return {
      tested: results.length,
      results,
    };
  },
});

// Import zod for the test task
import { z } from "zod";