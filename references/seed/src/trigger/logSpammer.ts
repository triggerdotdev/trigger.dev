import { logger, task, wait } from "@trigger.dev/sdk/v3";

const LONG_TEXT = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.`;

const SEARCHABLE_TERMS = [
  "authentication_failed",
  "database_connection_error",
  "payment_processed",
  "user_registration_complete",
  "api_rate_limit_exceeded",
  "cache_invalidation",
  "webhook_delivery_success",
  "session_expired",
  "file_upload_complete",
  "email_sent_successfully",
];

function generateLargeJson(index: number) {
  return {
    requestId: `req_${Date.now()}_${index}`,
    timestamp: new Date().toISOString(),
    metadata: {
      source: "log-spammer-task",
      environment: "development",
      version: "1.0.0",
      region: ["us-east-1", "eu-west-1", "ap-southeast-1"][index % 3],
    },
    user: {
      id: `user_${1000 + index}`,
      email: `testuser${index}@example.com`,
      name: `Test User ${index}`,
      preferences: {
        theme: index % 2 === 0 ? "dark" : "light",
        notifications: { email: true, push: false, sms: index % 3 === 0 },
        language: ["en", "es", "fr", "de"][index % 4],
      },
    },
    payload: {
      items: Array.from({ length: 5 }, (_, i) => ({
        itemId: `item_${index}_${i}`,
        name: `Product ${i}`,
        price: Math.random() * 100,
        quantity: Math.floor(Math.random() * 10) + 1,
        tags: ["electronics", "sale", "featured"].slice(0, (i % 3) + 1),
      })),
      totals: {
        subtotal: Math.random() * 500,
        tax: Math.random() * 50,
        shipping: Math.random() * 20,
        discount: Math.random() * 30,
      },
    },
    debugInfo: {
      stackTrace: `Error: ${SEARCHABLE_TERMS[index % SEARCHABLE_TERMS.length]}\n    at processRequest (/app/src/handlers/main.ts:${100 + index}:15)\n    at handleEvent (/app/src/events/processor.ts:${50 + index}:8)\n    at async Runtime.handler (/app/src/index.ts:25:3)`,
      memoryUsage: { heapUsed: 45000000 + index * 1000, heapTotal: 90000000 },
      cpuTime: Math.random() * 1000,
    },
    longDescription: LONG_TEXT.repeat(2),
  };
}

export const logSpammerTask = task({
  id: "log-spammer",
  maxDuration: 300,
  run: async () => {
    logger.info("Starting log spammer task for search testing");

    for (let i = 0; i < 50; i++) {
      const term = SEARCHABLE_TERMS[i % SEARCHABLE_TERMS.length];
      const jsonPayload = generateLargeJson(i);

      logger.log(`Processing event: ${term}`, { data: jsonPayload });

      if (i % 5 === 0) {
        logger.warn(`Warning triggered for ${term}`, {
          warningCode: `WARN_${i}`,
          details: jsonPayload,
          longMessage: LONG_TEXT,
        });
      }

      if (i % 10 === 0) {
        logger.error(`Error encountered: ${term}`, {
          errorCode: `ERR_${i}`,
          stack: jsonPayload.debugInfo.stackTrace,
          context: jsonPayload,
        });
      }

      logger.debug(`Debug info for iteration ${i}`, {
        iteration: i,
        searchTerm: term,
        fullPayload: jsonPayload,
        additionalText: `${LONG_TEXT} --- Iteration ${i} complete with term ${term}`,
      });

      if (i % 10 === 0) {
        await wait.for({ seconds: 0.5 });
      }
    }

    logger.info("Log spammer task completed", {
      totalLogs: 50 * 4,
      searchableTerms: SEARCHABLE_TERMS,
    });

    return { success: true, logsGenerated: 200 };
  },
});
