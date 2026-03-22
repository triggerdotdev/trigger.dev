import { describe, test, expect } from "vitest";
import { Webhook } from "@trigger.dev/core/v3/schemas";
import {
  generateErrorGroupWebhookPayload,
  type ErrorGroupAlertData,
} from "~/v3/services/alerts/errorGroupWebhook.server";

function createMockAlertData(
  overrides: Partial<ErrorGroupAlertData> = {}
): ErrorGroupAlertData {
  const now = new Date();
  const earlier = new Date(now.getTime() - 3600000); // 1 hour ago

  return {
    classification: "new_issue",
    error: {
      fingerprint: "fp_test_12345",
      environmentId: "env_abc123",
      environmentName: "Production",
      taskIdentifier: "process-payment",
      errorType: "TypeError",
      errorMessage: "Cannot read property 'id' of undefined",
      sampleStackTrace: `TypeError: Cannot read property 'id' of undefined
    at processPayment (src/tasks/payment.ts:42:15)
    at Object.run (src/tasks/payment.ts:15:20)`,
      firstSeen: earlier.toISOString(),
      lastSeen: now.toISOString(),
      occurrenceCount: 5,
    },
    organization: {
      id: "org_xyz789",
      slug: "acme-corp",
      name: "Acme Corp",
    },
    project: {
      id: "proj_123",
      externalRef: "proj_abc",
      slug: "my-project",
      name: "My Project",
    },
    dashboardUrl: "https://cloud.trigger.dev/orgs/acme-corp/projects/my-project/errors/fp_test_12345",
    ...overrides,
  };
}

describe("generateErrorGroupWebhookPayload", () => {
  test("generates a valid webhook payload", () => {
    const alertData = createMockAlertData();
    const payload = generateErrorGroupWebhookPayload(alertData);

    expect(payload).toMatchObject({
      type: "alert.error",
      object: {
        classification: "new_issue",
        error: {
          fingerprint: "fp_test_12345",
          type: "TypeError",
          message: "Cannot read property 'id' of undefined",
          taskIdentifier: "process-payment",
          occurrenceCount: 5,
        },
        environment: {
          id: "env_abc123",
          name: "Production",
        },
        organization: {
          id: "org_xyz789",
          slug: "acme-corp",
          name: "Acme Corp",
        },
        project: {
          id: "proj_123",
          ref: "proj_abc",
          slug: "my-project",
          name: "My Project",
        },
        dashboardUrl: "https://cloud.trigger.dev/orgs/acme-corp/projects/my-project/errors/fp_test_12345",
      },
    });

    expect(payload.id).toBeDefined();
    expect(payload.created).toBeInstanceOf(Date);
    expect(payload.webhookVersion).toBe("2025-01-01");
  });

  test("payload is valid according to Webhook schema", () => {
    const alertData = createMockAlertData();
    const payload = generateErrorGroupWebhookPayload(alertData);

    const parsed = Webhook.parse(payload);
    expect(parsed.type).toBe("alert.error");
  });

  test("payload can be serialized and deserialized", () => {
    const alertData = createMockAlertData();
    const payload = generateErrorGroupWebhookPayload(alertData);

    // Serialize to JSON (simulating sending over HTTP)
    const serialized = JSON.stringify(payload);
    const deserialized = JSON.parse(serialized);

    // Verify it can still be parsed by the schema
    const parsed = Webhook.parse(deserialized);
    expect(parsed.type).toBe("alert.error");

    if (parsed.type === "alert.error") {
      expect(parsed.object.classification).toBe("new_issue");
      expect(parsed.object.error.fingerprint).toBe("fp_test_12345");
    }
  });

  test("handles new_issue classification", () => {
    const alertData = createMockAlertData({ classification: "new_issue" });
    const payload = generateErrorGroupWebhookPayload(alertData);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.classification).toBe("new_issue");
    }
  });

  test("handles regression classification", () => {
    const alertData = createMockAlertData({ classification: "regression" });
    const payload = generateErrorGroupWebhookPayload(alertData);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.classification).toBe("regression");
    }
  });

  test("handles unignored classification", () => {
    const alertData = createMockAlertData({ classification: "unignored" });
    const payload = generateErrorGroupWebhookPayload(alertData);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.classification).toBe("unignored");
    }
  });

  test("handles empty stack trace", () => {
    const alertData = createMockAlertData({
      error: {
        ...createMockAlertData().error,
        sampleStackTrace: "",
      },
    });
    const payload = generateErrorGroupWebhookPayload(alertData);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.error.stackTrace).toBeUndefined();
    }
  });

  test("includes stack trace when present", () => {
    const stackTrace = "Error at line 42";
    const alertData = createMockAlertData({
      error: {
        ...createMockAlertData().error,
        sampleStackTrace: stackTrace,
      },
    });
    const payload = generateErrorGroupWebhookPayload(alertData);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.error.stackTrace).toBe(stackTrace);
    }
  });

  test("preserves date fields correctly", () => {
    const firstSeen = new Date("2024-01-01T00:00:00Z");
    const lastSeen = new Date("2024-01-02T12:00:00Z");

    const alertData = createMockAlertData({
      error: {
        ...createMockAlertData().error,
        firstSeen: firstSeen.toISOString(),
        lastSeen: lastSeen.toISOString(),
      },
    });

    const payload = generateErrorGroupWebhookPayload(alertData);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.error.firstSeen).toEqual(firstSeen);
      expect(parsed.object.error.lastSeen).toEqual(lastSeen);
    }
  });

  test("handles special characters in error messages", () => {
    const alertData = createMockAlertData({
      error: {
        ...createMockAlertData().error,
        errorMessage: "Unexpected token `<` in JSON at position 0",
        sampleStackTrace: `SyntaxError: Unexpected token \`<\` in JSON
    at JSON.parse (<anonymous>)
    at fetch("https://api.example.com/data?query=test&limit=10")`,
      },
    });

    const payload = generateErrorGroupWebhookPayload(alertData);
    const serialized = JSON.stringify(payload);
    const deserialized = JSON.parse(serialized);
    const parsed = Webhook.parse(deserialized);

    if (parsed.type === "alert.error") {
      expect(parsed.object.error.message).toBe("Unexpected token `<` in JSON at position 0");
    }
  });

  test("handles unicode and emoji in error messages", () => {
    const alertData = createMockAlertData({
      error: {
        ...createMockAlertData().error,
        errorMessage: "Failed to process emoji 🔥 in message: Hello 世界",
      },
    });

    const payload = generateErrorGroupWebhookPayload(alertData);
    const serialized = JSON.stringify(payload);
    const deserialized = JSON.parse(serialized);
    const parsed = Webhook.parse(deserialized);

    if (parsed.type === "alert.error") {
      expect(parsed.object.error.message).toBe("Failed to process emoji 🔥 in message: Hello 世界");
    }
  });

  test("handles large occurrence counts", () => {
    const alertData = createMockAlertData({
      error: {
        ...createMockAlertData().error,
        occurrenceCount: 999999,
      },
    });

    const payload = generateErrorGroupWebhookPayload(alertData);
    const parsed = Webhook.parse(payload);

    if (parsed.type === "alert.error") {
      expect(parsed.object.error.occurrenceCount).toBe(999999);
    }
  });
});
