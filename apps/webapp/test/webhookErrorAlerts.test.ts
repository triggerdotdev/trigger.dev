import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { DeliverErrorGroupAlertService } from "~/v3/services/alerts/deliverErrorGroupAlert.server";
import { prisma } from "~/db.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { Webhook } from "@trigger.dev/core/v3/schemas";

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

let testChannelId: string;
let testProjectId: string;
let testOrganizationId: string;
let webhookServer: ReturnType<typeof createWebhookServer> | null = null;

interface WebhookCall {
  payload: unknown;
  signature: string;
}

function createWebhookServer() {
  const calls: WebhookCall[] = [];

  return {
    calls,
    handler: async (request: Request) => {
      const signature = request.headers.get("x-trigger-signature-hmacsha256");
      const payload = await request.json();

      calls.push({
        payload,
        signature: signature || "",
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

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
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
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

describe("Webhook Error Alert Tests", () => {
  beforeAll(async () => {
    // Create test organization
    const organization = await prisma.organization.create({
      data: {
        title: "Webhook Test Org",
        slug: "webhook-test-org-" + Date.now(),
      },
    });
    testOrganizationId = organization.id;

    // Create test project
    const project = await prisma.project.create({
      data: {
        name: "Webhook Test Project",
        slug: "webhook-test-project-" + Date.now(),
        externalRef: "proj_webhook_test_" + Date.now(),
        organizationId: organization.id,
      },
    });
    testProjectId = project.id;

    // Create webhook server for testing
    webhookServer = createWebhookServer();

    // We'll use a mock webhook URL in the tests
    // In a real integration test, you'd start a local server
    // For now, we'll just test that the payload is constructed correctly
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
      await prisma.organization.deleteMany({
        where: { id: testOrganizationId },
      });
    }
  });

  test("webhook payload structure is valid", async () => {
    // This test verifies the payload structure without actually sending it
    const mockPayload = createMockErrorPayload({
      classification: "new_issue",
    });

    // Import the function to generate the payload
    const { generateErrorGroupWebhookPayload } = await import(
      "~/v3/services/alerts/errorGroupWebhook.server"
    );

    const webhookPayload = generateErrorGroupWebhookPayload({
      classification: mockPayload.classification,
      error: mockPayload.error,
      organization: {
        id: testOrganizationId,
        slug: "webhook-test-org",
        name: "Webhook Test Org",
      },
      project: {
        id: testProjectId,
        externalRef: "proj_webhook_test",
        slug: "webhook-test-project",
        name: "Webhook Test Project",
      },
      dashboardUrl: "https://cloud.trigger.dev/test",
    });

    // Verify it can be parsed by the Webhook schema
    const parsed = Webhook.parse(webhookPayload);
    expect(parsed.type).toBe("alert.error");

    if (parsed.type === "alert.error") {
      expect(parsed.object.classification).toBe("new_issue");
      expect(parsed.object.error.type).toBe("TypeError");
      expect(parsed.object.organization.slug).toBe("webhook-test-org");
      expect(parsed.object.project.ref).toBe("proj_webhook_test");
    }
  });

  test("webhook payload can be serialized and deserialized", async () => {
    const mockPayload = createMockErrorPayload({
      classification: "regression",
    });

    const { generateErrorGroupWebhookPayload } = await import(
      "~/v3/services/alerts/errorGroupWebhook.server"
    );

    const webhookPayload = generateErrorGroupWebhookPayload({
      classification: mockPayload.classification,
      error: mockPayload.error,
      organization: {
        id: testOrganizationId,
        slug: "webhook-test-org",
        name: "Webhook Test Org",
      },
      project: {
        id: testProjectId,
        externalRef: "proj_webhook_test",
        slug: "webhook-test-project",
        name: "Webhook Test Project",
      },
      dashboardUrl: "https://cloud.trigger.dev/test",
    });

    // Serialize to JSON (simulating HTTP transmission)
    const serialized = JSON.stringify(webhookPayload);
    const deserialized = JSON.parse(serialized);

    // Verify it can still be parsed
    const parsed = Webhook.parse(deserialized);
    expect(parsed.type).toBe("alert.error");

    if (parsed.type === "alert.error") {
      expect(parsed.object.classification).toBe("regression");
      expect(parsed.object.error.fingerprint).toBe(mockPayload.error.fingerprint);
    }
  });

  test("webhook payload includes all classifications", async () => {
    const classifications = ["new_issue", "regression", "unignored"] as const;

    const { generateErrorGroupWebhookPayload } = await import(
      "~/v3/services/alerts/errorGroupWebhook.server"
    );

    for (const classification of classifications) {
      const mockPayload = createMockErrorPayload({ classification });

      const webhookPayload = generateErrorGroupWebhookPayload({
        classification: mockPayload.classification,
        error: mockPayload.error,
        organization: {
          id: testOrganizationId,
          slug: "webhook-test-org",
          name: "Webhook Test Org",
        },
        project: {
          id: testProjectId,
          externalRef: "proj_webhook_test",
          slug: "webhook-test-project",
          name: "Webhook Test Project",
        },
        dashboardUrl: "https://cloud.trigger.dev/test",
      });

      const parsed = Webhook.parse(webhookPayload);
      if (parsed.type === "alert.error") {
        expect(parsed.object.classification).toBe(classification);
      }
    }
  });

  test("webhook payload includes error details", async () => {
    const mockPayload = createMockErrorPayload({
      error: {
        fingerprint: "fp_custom_123",
        errorType: "CustomError",
        errorMessage: "Custom error message",
        sampleStackTrace: "CustomError: at line 42",
        taskIdentifier: "my-custom-task",
        occurrenceCount: 999,
      } as any,
    });

    const { generateErrorGroupWebhookPayload } = await import(
      "~/v3/services/alerts/errorGroupWebhook.server"
    );

    const webhookPayload = generateErrorGroupWebhookPayload({
      classification: mockPayload.classification,
      error: mockPayload.error,
      organization: {
        id: testOrganizationId,
        slug: "webhook-test-org",
        name: "Webhook Test Org",
      },
      project: {
        id: testProjectId,
        externalRef: "proj_webhook_test",
        slug: "webhook-test-project",
        name: "Webhook Test Project",
      },
      dashboardUrl: "https://cloud.trigger.dev/test",
    });

    const parsed = Webhook.parse(webhookPayload);
    if (parsed.type === "alert.error") {
      expect(parsed.object.error.fingerprint).toBe("fp_custom_123");
      expect(parsed.object.error.type).toBe("CustomError");
      expect(parsed.object.error.message).toBe("Custom error message");
      expect(parsed.object.error.stackTrace).toBe("CustomError: at line 42");
      expect(parsed.object.error.taskIdentifier).toBe("my-custom-task");
      expect(parsed.object.error.occurrenceCount).toBe(999);
    }
  });

  test("webhook payload handles empty stack trace", async () => {
    const mockPayload = createMockErrorPayload({
      error: {
        sampleStackTrace: "",
      } as any,
    });

    const { generateErrorGroupWebhookPayload } = await import(
      "~/v3/services/alerts/errorGroupWebhook.server"
    );

    const webhookPayload = generateErrorGroupWebhookPayload({
      classification: mockPayload.classification,
      error: mockPayload.error,
      organization: {
        id: testOrganizationId,
        slug: "webhook-test-org",
        name: "Webhook Test Org",
      },
      project: {
        id: testProjectId,
        externalRef: "proj_webhook_test",
        slug: "webhook-test-project",
        name: "Webhook Test Project",
      },
      dashboardUrl: "https://cloud.trigger.dev/test",
    });

    const parsed = Webhook.parse(webhookPayload);
    if (parsed.type === "alert.error") {
      expect(parsed.object.error.stackTrace).toBeUndefined();
    }
  });
});
