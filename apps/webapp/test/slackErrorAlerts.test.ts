import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { DeliverErrorGroupAlertService } from "../app/v3/services/alerts/deliverErrorGroupAlert.server.js";
import { prisma } from "../app/db.server.js";
import { getSecretStore } from "../app/services/secrets/secretStore.server.js";

// Helper type matching the service's ErrorAlertPayload
type ErrorAlertPayload = {
  channelId: string;
  projectId: string;
  classification: "new_issue" | "regression" | "unignored";
  error: {
    fingerprint: string;
    environmentId: string;
    environmentSlug: string;
    environmentName: string;
    taskIdentifier: string;
    errorType: string;
    errorMessage: string;
    sampleStackTrace: string;
    firstSeen: string;
    lastSeen: string;
    occurrenceCount: number;
  };
};

// Test context for database setup
let testChannelId: string;
let testProjectId: string;
let testOrganizationId: string;

// Helper to create mock error payloads
function createMockErrorPayload(
  overrides: Partial<Omit<ErrorAlertPayload, "error">> & {
    error?: Partial<ErrorAlertPayload["error"]>;
  } = {}
): ErrorAlertPayload {
  const { error: errorOverrides, ...payloadOverrides } = overrides;

  const defaultError: ErrorAlertPayload["error"] = {
    fingerprint: "fp_test_" + Date.now(),
    environmentId: "env_test_dev",
    environmentSlug: "dev",
    environmentName: "Development",
    taskIdentifier: "process-payment",
    errorType: "TypeError",
    errorMessage: "Cannot read property 'id' of undefined",
    sampleStackTrace: `TypeError: Cannot read property 'id' of undefined
    at processPayment (src/tasks/payment.ts:42:15)
    at Object.run (src/tasks/payment.ts:15:20)
    at TaskExecutor.execute (node_modules/@trigger.dev/core/dist/index.js:234:18)`,
    firstSeen: Date.now().toString(),
    lastSeen: Date.now().toString(),
    occurrenceCount: 42,
    ...errorOverrides,
  };

  return {
    channelId: testChannelId,
    projectId: testProjectId,
    classification: "new_issue",
    ...payloadOverrides,
    error: defaultError,
  };
}

// Skip tests if Slack credentials not configured
const hasSlackCredentials =
  !!process.env.TEST_SLACK_CHANNEL_ID &&
  !!process.env.TEST_SLACK_BOT_TOKEN;

describe.skipIf(!hasSlackCredentials)("Slack Error Alert Visual Tests", () => {
  beforeAll(async () => {
    // Create test organization
    const organization = await prisma.organization.create({
      data: {
        title: "Slack Test Org",
        slug: "slack-test-org-" + Date.now(),
      },
    });
    testOrganizationId = organization.id;

    // Create test project
    const project = await prisma.project.create({
      data: {
        name: "Slack Test Project",
        slug: "slack-test-project-" + Date.now(),
        externalRef: "proj_slack_test_" + Date.now(),
        organizationId: organization.id,
      },
    });
    testProjectId = project.id;

    // Create secret reference for Slack token
    const secretStore = getSecretStore("DATABASE");
    const secretKey = `slack-test-token-${Date.now()}`;

    await secretStore.setSecret(secretKey, {
      botAccessToken: process.env.TEST_SLACK_BOT_TOKEN!,
    });

    const secretReference = await prisma.secretReference.create({
      data: {
        key: secretKey,
        provider: "DATABASE",
      },
    });

    // Create Slack organization integration
    const integration = await prisma.organizationIntegration.create({
      data: {
        friendlyId: "integration_test_" + Date.now(),
        organizationId: organization.id,
        service: "SLACK",
        integrationData: {},
        tokenReferenceId: secretReference.id,
      },
    });

    // Create alert channel
    const channel = await prisma.projectAlertChannel.create({
      data: {
        friendlyId: "channel_test_" + Date.now(),
        name: "Test Slack Channel",
        type: "SLACK",
        enabled: true,
        projectId: project.id,
        integrationId: integration.id,
        properties: {
          channelId: process.env.TEST_SLACK_CHANNEL_ID!,
          channelName: "test-slack-alerts",
          integrationId: integration.id,
        },
      },
    });
    testChannelId = channel.id;
  });

  afterAll(async () => {
    // Clean up test data
    if (testChannelId) {
      await prisma.projectAlertChannel.deleteMany({
        where: { id: testChannelId },
      });
    }
    if (testProjectId) {
      await prisma.project.deleteMany({
        where: { id: testProjectId },
      });
    }
    if (testOrganizationId) {
      await prisma.organizationIntegration.deleteMany({
        where: { organizationId: testOrganizationId },
      });
      await prisma.organization.deleteMany({
        where: { id: testOrganizationId },
      });
    }
  });

  test("new_issue classification", async () => {
    const payload = createMockErrorPayload({
      classification: "new_issue",
      error: {
        taskIdentifier: "process-order",
        errorMessage: "Failed to process order due to invalid payment method",
        errorType: "PaymentError",
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    // Message sent - check Slack channel visually
    expect(true).toBe(true);
  });

  test("regression classification", async () => {
    const payload = createMockErrorPayload({
      classification: "regression",
      error: {
        taskIdentifier: "send-email",
        errorMessage: "SMTP connection timeout after 30 seconds",
        errorType: "TimeoutError",
        occurrenceCount: 156,
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("unignored (resurfaced) classification", async () => {
    const payload = createMockErrorPayload({
      classification: "unignored",
      error: {
        taskIdentifier: "sync-database",
        errorMessage: "Connection pool exhausted",
        errorType: "DatabaseError",
        occurrenceCount: 99,
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("short error message", async () => {
    const payload = createMockErrorPayload({
      error: {
        errorMessage: "Not found",
        errorType: "NotFoundError",
        sampleStackTrace: "NotFoundError: Not found\n    at findUser (src/db.ts:10:5)",
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("long stack trace", async () => {
    const longStackTrace = `ReferenceError: processData is not defined
    at handler (src/tasks/data-processor.ts:125:15)
    at async TaskRunner.execute (node_modules/@trigger.dev/sdk/dist/runner.js:89:12)
    at async WorkerThread.processTask (node_modules/@trigger.dev/sdk/dist/worker.js:234:18)
    at async WorkerPool.run (src/lib/worker-pool.ts:56:10)
    at async TaskQueue.dequeue (src/lib/queue.ts:142:8)
    at async Orchestrator.processNextTask (src/orchestrator.ts:98:5)
    at async Orchestrator.start (src/orchestrator.ts:45:7)
    at async main (src/index.ts:12:3)
    at Object.<anonymous> (src/index.ts:20:1)
    at Module._compile (node:internal/modules/cjs/loader:1376:14)
    at Module._extensions..js (node:internal/modules/cjs/loader:1435:10)
    at Module.load (node:internal/modules/cjs/loader:1207:32)
    at Module._load (node:internal/modules/cjs/loader:1023:12)
    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:135:12)
    at node:internal/main/run_main_module:28:49`;

    const payload = createMockErrorPayload({
      error: {
        errorType: "ReferenceError",
        errorMessage: "processData is not defined",
        sampleStackTrace: longStackTrace,
        taskIdentifier: "data-processor",
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("very long error message (triggers truncation)", async () => {
    // Create a message that's over 3000 characters
    const longMessage = "x".repeat(3500);
    const longStackTrace = `Error: ${longMessage}
    at verylongfunctionname (src/tasks/long-task.ts:1:1)
    ${"    at stackframe (file.ts:1:1)\n".repeat(100)}`;

    const payload = createMockErrorPayload({
      error: {
        errorMessage: longMessage,
        sampleStackTrace: longStackTrace,
        taskIdentifier: "long-error-task",
        errorType: "Error",
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    // Should see truncation message in Slack
    expect(true).toBe(true);
  });

  test("special characters in error", async () => {
    const payload = createMockErrorPayload({
      error: {
        errorMessage: "Unexpected token `<` in JSON at position 0",
        errorType: "SyntaxError",
        sampleStackTrace: `SyntaxError: Unexpected token \`<\` in JSON at position 0
    at JSON.parse (<anonymous>)
    at parseResponse (src/api/client.ts:42:15)
    at fetch("https://api.example.com/data?query=test&limit=10")`,
        taskIdentifier: "api-fetch-task",
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("unicode and emoji in error", async () => {
    const payload = createMockErrorPayload({
      error: {
        errorMessage: "Failed to process emoji 🔥 in message: Hello 世界",
        errorType: "EncodingError",
        sampleStackTrace: `EncodingError: Failed to process emoji 🔥 in message: Hello 世界
    at encodeMessage (src/utils/encoding.ts:15:10)
    at sendMessage (src/tasks/messaging.ts:42:8)`,
        taskIdentifier: "messaging-task",
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("different error types - TypeError", async () => {
    const payload = createMockErrorPayload({
      error: {
        errorType: "TypeError",
        errorMessage: "Cannot call method 'map' on undefined",
        sampleStackTrace: `TypeError: Cannot call method 'map' on undefined
    at transformData (src/transformers/data.ts:18:25)`,
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("different error types - ReferenceError", async () => {
    const payload = createMockErrorPayload({
      error: {
        errorType: "ReferenceError",
        errorMessage: "userConfig is not defined",
        sampleStackTrace: `ReferenceError: userConfig is not defined
    at initializeApp (src/app.ts:32:10)`,
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("different error types - Custom Error", async () => {
    const payload = createMockErrorPayload({
      error: {
        errorType: "InvalidConfigurationError",
        errorMessage: "API key is missing or invalid",
        sampleStackTrace: `InvalidConfigurationError: API key is missing or invalid
    at validateConfig (src/config/validator.ts:45:11)
    at loadConfig (src/config/loader.ts:23:5)`,
        taskIdentifier: "config-loader",
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });

  test("error with no stack trace", async () => {
    const payload = createMockErrorPayload({
      error: {
        errorMessage: "An unknown error occurred",
        errorType: "Error",
        sampleStackTrace: "",
      },
    });

    const service = new DeliverErrorGroupAlertService();
    await service.call(payload);

    expect(true).toBe(true);
  });
});
