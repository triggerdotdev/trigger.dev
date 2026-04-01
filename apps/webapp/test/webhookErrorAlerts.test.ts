import { describe, test, expect } from "vitest";
import { Webhook } from "@trigger.dev/core/v3/schemas";
import { generateErrorGroupWebhookPayload } from "~/v3/services/alerts/errorGroupWebhook.server";

type ErrorData = {
  fingerprint: string;
  environmentId: string;
  environmentName: string;
  taskIdentifier: string;
  errorType: string;
  errorMessage: string;
  sampleStackTrace: string;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
};

const TEST_ORG = { id: "org_test_123", slug: "webhook-test-org", name: "Webhook Test Org" };
const TEST_PROJECT = {
  id: "proj_test_456",
  externalRef: "proj_webhook_test",
  slug: "webhook-test-project",
  name: "Webhook Test Project",
};
const DASHBOARD_URL = "https://cloud.trigger.dev/test";

function createMockError(overrides: Partial<ErrorData> = {}): ErrorData {
  return {
    fingerprint: "fp_test_default",
    environmentId: "env_test_dev",
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
    ...overrides,
  };
}

function buildPayload(classification: "new_issue" | "regression" | "unignored", error: ErrorData) {
  return generateErrorGroupWebhookPayload({
    classification,
    error,
    organization: TEST_ORG,
    project: TEST_PROJECT,
    dashboardUrl: DASHBOARD_URL,
  });
}

describe("Webhook Error Alert Payload", () => {
  test("payload structure is valid and parseable", () => {
    const payload = buildPayload("new_issue", createMockError());
    const parsed = Webhook.parse(payload);

    expect(parsed.type).toBe("alert.error");
    if (parsed.type === "alert.error") {
      expect(parsed.object.classification).toBe("new_issue");
      expect(parsed.object.error.type).toBe("TypeError");
      expect(parsed.object.organization.slug).toBe("webhook-test-org");
      expect(parsed.object.project.ref).toBe("proj_webhook_test");
    }
  });

  test("payload survives JSON round-trip", () => {
    const error = createMockError();
    const payload = buildPayload("regression", error);

    const deserialized = JSON.parse(JSON.stringify(payload));
    const parsed = Webhook.parse(deserialized);

    expect(parsed.type).toBe("alert.error");
    if (parsed.type === "alert.error") {
      expect(parsed.object.classification).toBe("regression");
      expect(parsed.object.error.fingerprint).toBe(error.fingerprint);
    }
  });

  test("all classifications are valid", () => {
    const classifications = ["new_issue", "regression", "unignored"] as const;

    for (const classification of classifications) {
      const payload = buildPayload(classification, createMockError());
      const parsed = Webhook.parse(payload);
      if (parsed.type === "alert.error") {
        expect(parsed.object.classification).toBe(classification);
      }
    }
  });

  test("error details are preserved", () => {
    const error = createMockError({
      fingerprint: "fp_custom_123",
      errorType: "CustomError",
      errorMessage: "Custom error message",
      sampleStackTrace: "CustomError: at line 42",
      taskIdentifier: "my-custom-task",
      occurrenceCount: 999,
    });

    const payload = buildPayload("new_issue", error);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.error.fingerprint).toBe("fp_custom_123");
      expect(parsed.object.error.type).toBe("CustomError");
      expect(parsed.object.error.message).toBe("Custom error message");
      expect(parsed.object.error.stackTrace).toBe("CustomError: at line 42");
      expect(parsed.object.error.taskIdentifier).toBe("my-custom-task");
      expect(parsed.object.error.occurrenceCount).toBe(999);
    }
  });

  test("empty stack trace becomes undefined", () => {
    const error = createMockError({ sampleStackTrace: "" });
    const payload = buildPayload("new_issue", error);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.error.stackTrace).toBeUndefined();
    }
  });
});
