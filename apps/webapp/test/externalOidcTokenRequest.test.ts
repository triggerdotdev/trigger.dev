import { describe, expect, it } from "vitest";
import { ExternalOidcTokenRequest } from "~/services/oidc/externalOidcTokenRequest";

describe("external OIDC token requests", () => {
  // Catches: breaking existing callers or treating an explicitly disabled option as an opt-in.
  it.each([
    { audience: "custom-service" },
    { audience: "custom-service", awsSessionTags: false },
    { audience: "sts.amazonaws.com", awsSessionTags: true },
  ])("accepts supported token options: %j", (request) => {
    expect(ExternalOidcTokenRequest.safeParse(request).success).toBe(true);
  });

  // Catches: accepting caller-chosen authorization attributes or tagging non-AWS tokens.
  it.each([
    { audience: "custom-service", awsSessionTags: true },
    { audience: "sts.amazonaws.com", awsSessionTags: "true" },
    { audience: "sts.amazonaws.com", awsSessionTags: { TriggerTaskId: "another-task" } },
    { audience: "sts.amazonaws.com", awsSessionTags: true, taskId: "another-task" },
  ])("rejects unsupported tag requests: %j", (request) => {
    expect(ExternalOidcTokenRequest.safeParse(request).success).toBe(false);
  });
});
