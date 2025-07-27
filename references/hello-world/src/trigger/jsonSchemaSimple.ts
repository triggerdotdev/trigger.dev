import { task, schemaTask, logger, type JSONSchema } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// ===========================================
// The Two Main Approaches
// ===========================================

// Approach 1: Using schemaTask (Recommended)
// - Automatic JSON Schema conversion
// - Full TypeScript type safety
// - Runtime validation built-in
const emailSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(z.object({
    filename: z.string(),
    url: z.string().url(),
  })).optional(),
});

export const sendEmailSchemaTask = schemaTask({
  id: "send-email-schema-task",
  schema: emailSchema,
  run: async (payload, { ctx }) => {
    // payload is fully typed as:
    // {
    //   to: string;
    //   subject: string;
    //   body: string;
    //   attachments?: Array<{ filename: string; url: string; }>;
    // }
    
    logger.info("Sending email", { 
      to: payload.to,
      subject: payload.subject,
      hasAttachments: !!payload.attachments?.length,
    });

    // Your email sending logic here...
    
    return {
      sent: true,
      messageId: `msg_${ctx.run.id}`,
      sentAt: new Date().toISOString(),
    };
  },
});

// Approach 2: Using plain task with payloadSchema
// - Manual JSON Schema definition
// - No automatic type inference (payload is 'any')
// - Good for when you already have JSON Schema definitions
export const sendEmailPlainTask = task({
  id: "send-email-plain-task",
  payloadSchema: {
    type: "object",
    properties: {
      to: { 
        type: "string", 
        format: "email",
        description: "Recipient email address",
      },
      subject: { 
        type: "string",
        maxLength: 200,
      },
      body: { 
        type: "string",
      },
      attachments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            filename: { type: "string" },
            url: { type: "string", format: "uri" },
          },
          required: ["filename", "url"],
        },
      },
    },
    required: ["to", "subject", "body"],
  } satisfies JSONSchema, // Use 'satisfies' for type checking
  run: async (payload, { ctx }) => {
    // payload is typed as 'any' - you need to validate/cast it yourself
    logger.info("Sending email", { 
      to: payload.to,
      subject: payload.subject,
    });

    // Your email sending logic here...
    
    return {
      sent: true,
      messageId: `msg_${ctx.run.id}`,
      sentAt: new Date().toISOString(),
    };
  },
});

// ===========================================
// Benefits of JSON Schema
// ===========================================

// 1. Documentation - The schema is visible in the Trigger.dev dashboard
// 2. Validation - Invalid payloads are rejected before execution
// 3. Type Safety - With schemaTask, you get full TypeScript support
// 4. OpenAPI Generation - Can be used to generate API documentation
// 5. Client SDKs - Can generate typed clients for other languages

export const demonstrateBenefits = task({
  id: "json-schema-benefits-demo",
  run: async (_, { ctx }) => {
    logger.info("Demonstrating JSON Schema benefits");

    // With schemaTask, TypeScript prevents invalid payloads at compile time
    try {
      await sendEmailSchemaTask.trigger({
        to: "user@example.com",
        subject: "Welcome!",
        body: "Thanks for signing up!",
        // TypeScript error if you try to add invalid fields
        // invalidField: "This would cause a TypeScript error",
      });
    } catch (error) {
      logger.error("Failed to send email", { error });
    }

    // With plain task, validation happens at runtime
    try {
      await sendEmailPlainTask.trigger({
        to: "not-an-email", // This will fail validation at runtime
        subject: "Test",
        body: "Test email",
      });
    } catch (error) {
      logger.error("Failed validation", { error });
    }

    return { demonstrated: true };
  },
});

// ===========================================
// Real-World Example: User Registration Flow
// ===========================================
const userRegistrationSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(8),
  profile: z.object({
    firstName: z.string(),
    lastName: z.string(),
    dateOfBirth: z.string().optional(), // ISO date string
    preferences: z.object({
      newsletter: z.boolean().default(false),
      notifications: z.boolean().default(true),
    }).default({}),
  }),
  referralCode: z.string().optional(),
});

export const registerUser = schemaTask({
  id: "register-user",
  schema: userRegistrationSchema,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
  },
  run: async (payload, { ctx }) => {
    logger.info("Registering new user", { 
      email: payload.email,
      username: payload.username,
    });

    // Step 1: Validate uniqueness
    logger.info("Checking if user exists");
    // ... database check logic ...

    // Step 2: Create user account
    logger.info("Creating user account");
    const userId = `user_${Date.now()}`;
    // ... user creation logic ...

    // Step 3: Send welcome email
    await sendEmailSchemaTask.trigger({
      to: payload.email,
      subject: `Welcome to our platform, ${payload.profile.firstName}!`,
      body: `Hi ${payload.profile.firstName},\n\nThanks for joining us...`,
    });

    // Step 4: Apply referral code if provided
    if (payload.referralCode) {
      logger.info("Processing referral code", { code: payload.referralCode });
      // ... referral logic ...
    }

    return {
      success: true,
      userId,
      username: payload.username,
      welcomeEmailSent: true,
    };
  },
});

// ===========================================
// When to Use Each Approach
// ===========================================

/*
Use schemaTask when:
- You're already using Zod, Yup, ArkType, etc. in your codebase
- You want TypeScript type inference
- You want runtime validation handled automatically
- You're building new tasks from scratch

Use plain task with payloadSchema when:
- You have existing JSON Schema definitions
- You're migrating from another system that uses JSON Schema
- You need fine-grained control over the schema format
- You're working with generated schemas from OpenAPI/Swagger
*/