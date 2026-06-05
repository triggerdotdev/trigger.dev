import { describe, expect, it } from "vitest";
import { publicAuthError, sanitizeAuthFailure } from "../app/services/routeBuilders/publicAuthError.js";

describe("publicAuthError", () => {
  it("returns a fixed client-safe message for 401", () => {
    expect(publicAuthError(401)).toBe("Invalid credentials");
  });

  it("returns a fixed client-safe message for 403", () => {
    expect(publicAuthError(403)).toBe("Forbidden");
  });
});

describe("sanitizeAuthFailure", () => {
  it("preserves the status so client retry logic still works", () => {
    expect(sanitizeAuthFailure({ status: 401, error: "Invalid API key" }).status).toBe(401);
    expect(sanitizeAuthFailure({ status: 403, error: "Unauthorized" }).status).toBe(403);
  });

  it("never echoes the controller's raw error string", () => {
    // The exact production leak: the RBAC plugin conflated an infra failure
    // with an auth rejection and returned the raw Prisma message — carrying
    // the prod RDS hostname — as its `error` string. The SDK then surfaced
    // it verbatim in the customer's run view via TriggerApiError.
    const leaked =
      "Invalid `prisma.project.findFirst()` invocation:\n\nCan't reach database server at " +
      "`trigger-app-prod-database.cluster-cghdbxygvjc4.us-east-1.rds.amazonaws.com:5432`";

    // Sanity: the fixture is genuinely leaky.
    expect(leaked).toContain("rds.amazonaws.com");

    const sanitized = sanitizeAuthFailure({ status: 401, error: leaked });

    expect(sanitized.error).toBe("Invalid credentials");
    expect(sanitized.error).not.toContain("prisma");
    expect(sanitized.error).not.toContain("rds.amazonaws.com");
    expect(sanitized.error).not.toContain("database server");
  });
});
