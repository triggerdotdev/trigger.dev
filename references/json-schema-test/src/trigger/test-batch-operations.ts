import { schemaTask, task } from "@trigger.dev/sdk/v3";
import { z } from "zod";

// Define schemas for batch operations
const emailSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

const smsSchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{1,14}$/),
  message: z.string().max(160),
});

const notificationSchema = z.object({
  userId: z.string(),
  title: z.string(),
  message: z.string(),
  type: z.enum(["info", "warning", "error", "success"]),
  metadata: z.record(z.unknown()).optional(),
});

// Create schema tasks
export const sendEmail = schemaTask({
  id: "send-email",
  schema: emailSchema,
  run: async (payload, { ctx }) => {
    // Simulate sending email
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
    
    return {
      messageId: `email_${ctx.run.id}`,
      sentAt: new Date().toISOString(),
      to: payload.to,
      subject: payload.subject,
      priority: payload.priority,
    };
  },
});

export const sendSms = schemaTask({
  id: "send-sms",
  schema: smsSchema,
  run: async (payload, { ctx }) => {
    // Simulate sending SMS
    await new Promise(resolve => setTimeout(resolve, Math.random() * 500));
    
    return {
      messageId: `sms_${ctx.run.id}`,
      sentAt: new Date().toISOString(),
      to: payload.phoneNumber,
      characterCount: payload.message.length,
    };
  },
});

export const sendNotification = schemaTask({
  id: "send-notification",
  schema: notificationSchema,
  run: async (payload, { ctx }) => {
    // Simulate sending notification
    await new Promise(resolve => setTimeout(resolve, Math.random() * 300));
    
    return {
      notificationId: `notif_${ctx.run.id}`,
      sentAt: new Date().toISOString(),
      userId: payload.userId,
      type: payload.type,
      delivered: Math.random() > 0.1, // 90% success rate
    };
  },
});

// Test batch operations with schema tasks
export const testBatchTrigger = task({
  id: "test-batch-trigger",
  run: async (_, { ctx }) => {
    // Batch trigger emails
    const emailBatch = await sendEmail.batchTrigger([
      {
        payload: {
          to: "user1@example.com",
          subject: "Welcome!",
          body: "Welcome to our service.",
          priority: "high",
        },
      },
      {
        payload: {
          to: "user2@example.com",
          subject: "Weekly Update",
          body: "Here's your weekly update.",
          // priority will default to "normal"
        },
      },
      {
        payload: {
          to: "user3@example.com",
          subject: "Special Offer",
          body: "Check out our special offer!",
          priority: "low",
        },
      },
    ]);

    // Batch trigger SMS messages
    const smsBatch = await sendSms.batchTrigger([
      {
        payload: {
          phoneNumber: "+1234567890",
          message: "Your verification code is 123456",
        },
      },
      {
        payload: {
          phoneNumber: "+9876543210",
          message: "Appointment reminder: Tomorrow at 2PM",
        },
      },
    ]);

    return {
      emailBatchId: emailBatch.batchId,
      emailCount: emailBatch.runCount,
      smsBatchId: smsBatch.batchId,
      smsCount: smsBatch.runCount,
    };
  },
});

// Test batch trigger and wait
export const testBatchTriggerAndWait = task({
  id: "test-batch-trigger-and-wait",
  run: async (_, { ctx }) => {
    // Batch trigger and wait for notifications
    const notificationResults = await sendNotification.batchTriggerAndWait([
      {
        payload: {
          userId: "user123",
          title: "Info",
          message: "This is an informational message",
          type: "info",
        },
      },
      {
        payload: {
          userId: "user456",
          title: "Warning",
          message: "This is a warning message",
          type: "warning",
          metadata: {
            source: "system",
            priority: "medium",
          },
        },
      },
      {
        payload: {
          userId: "user789",
          title: "Success",
          message: "Operation completed successfully",
          type: "success",
        },
      },
    ]);

    // Process results
    const successCount = notificationResults.runs.filter(run => run.ok).length;
    const failureCount = notificationResults.runs.filter(run => !run.ok).length;
    const deliveredCount = notificationResults.runs
      .filter(run => run.ok && run.output.delivered)
      .length;

    // Collect all notification IDs
    const notificationIds = notificationResults.runs
      .filter(run => run.ok)
      .map(run => run.output.notificationId);

    // Type safety check - these should all be properly typed
    for (const run of notificationResults.runs) {
      if (run.ok) {
        const notifId: string = run.output.notificationId;
        const sentAt: string = run.output.sentAt;
        const userId: string = run.output.userId;
        const type: "info" | "warning" | "error" | "success" = run.output.type;
        const delivered: boolean = run.output.delivered;
      }
    }

    return {
      batchId: notificationResults.id,
      totalRuns: notificationResults.runs.length,
      successCount,
      failureCount,
      deliveredCount,
      notificationIds,
    };
  },
});

// Test mixed batch operations
export const testMixedBatchOperations = task({
  id: "test-mixed-batch-operations",
  run: async (_, { ctx }) => {
    // Trigger different types of messages for the same user
    const results = await Promise.all([
      // Send welcome email
      sendEmail.trigger({
        to: "newuser@example.com",
        subject: "Welcome to our platform!",
        body: "Thanks for signing up. Here's what you need to know...",
        priority: "high",
      }),
      
      // Send SMS verification
      sendSms.trigger({
        phoneNumber: "+1234567890",
        message: "Welcome! Your verification code is 789012",
      }),
      
      // Send in-app notification
      sendNotification.trigger({
        userId: "newuser123",
        title: "Account Created",
        message: "Your account has been successfully created",
        type: "success",
        metadata: {
          accountType: "premium",
          referralCode: "WELCOME2024",
        },
      }),
    ]);

    // Wait for specific tasks using triggerAndWait
    const criticalEmail = await sendEmail.triggerAndWait({
      to: "admin@example.com",
      subject: "New User Alert",
      body: "A new premium user has signed up",
      priority: "high",
    });

    if (criticalEmail.ok) {
      const messageId: string = criticalEmail.output.messageId;
      const sentAt: string = criticalEmail.output.sentAt;
      
      return {
        allMessagesSent: true,
        emailId: results[0].id,
        smsId: results[1].id,
        notificationId: results[2].id,
        criticalEmailId: messageId,
        criticalEmailSentAt: sentAt,
      };
    } else {
      return {
        allMessagesSent: false,
        error: "Failed to send critical email",
      };
    }
  },
});

// Test error handling in batch operations
export const testBatchErrorHandling = task({
  id: "test-batch-error-handling",
  run: async (_, { ctx }) => {
    // Create a batch with some invalid data to test error handling
    const results = await sendEmail.batchTriggerAndWait([
      {
        payload: {
          to: "valid@example.com",
          subject: "Valid Email",
          body: "This should succeed",
        },
      },
      {
        payload: {
          to: "another.valid@example.com",
          subject: "Another Valid Email",
          body: "This should also succeed",
          priority: "normal",
        },
      },
      // Note: We can't actually create invalid payloads at compile time
      // because TypeScript prevents it! This is the power of schema tasks.
      // If we tried to add { to: "invalid-email", ... }, TypeScript would error
    ]);

    // Process results with proper type safety
    const report = {
      totalAttempts: results.runs.length,
      successful: [] as string[],
      failed: [] as { id: string; error: string }[],
    };

    for (const run of results.runs) {
      if (run.ok) {
        report.successful.push(run.output.messageId);
      } else {
        report.failed.push({
          id: run.id,
          error: String(run.error),
        });
      }
    }

    return report;
  },
});