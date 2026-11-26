import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

// The audit actor for a request made with an organization access token, from the real token row:
// a token the platform minted for itself is Trigger.dev, so its request shows no IP to the customer.

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));

import { authenticateRequest } from "~/services/apiAuth.server";
import { getRequestAuditContext } from "~/services/auditLogs/auditContext.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import { hashToken } from "~/utils/tokens.server";
import { createTestOrgProjectWithMember, uniqueId } from "./fixtures/environmentVariablesFixtures";

/** Authenticates `token` through the API auth entry point, which notes the caller. */
async function auditContextFor(token: string) {
  const request = new Request("https://api.trigger.dev/api/v1/projects/proj/branches", {
    headers: { Authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.7" },
  });
  return runWithHttpContext(
    {
      requestId: "req_test",
      path: "/api/v1/test",
      host: "api.trigger.dev",
      method: "GET",
      abortController: new AbortController(),
    },
    async () => {
      const result = await authenticateRequest(request, {
        personalAccessToken: false,
        organizationAccessToken: true,
        apiKey: false,
      });
      expect(result?.type, "the token didn't authenticate").toBe("organizationAccessToken");
      return getRequestAuditContext(new Date("2026-11-23T00:00:00Z"));
    }
  );
}

async function createToken(prisma: PrismaClient, type: "USER" | "SYSTEM") {
  const { organization } = await createTestOrgProjectWithMember(prisma);
  const token = `tr_oat_${uniqueId("token").replace(/-/g, "")}`;
  const row = await prisma.organizationAccessToken.create({
    data: {
      name: type === "SYSTEM" ? "build build_1" : "deploy-bot",
      type,
      hashedToken: hashToken(token),
      organizationId: organization.id,
    },
  });
  return { token, row };
}

describe("audit actor for an organization access token", () => {
  // Catches: a build's platform-minted org token recorded as a customer's token, with the build
  // server's IP shown to the customer.
  postgresTest(
    "records a system token as Trigger.dev infrastructure, keeping the token",
    async ({ prisma }) => {
      db.client = prisma;
      const { token, row } = await createToken(prisma, "SYSTEM");

      const context = await auditContextFor(token);

      expect(context.actor).toEqual({ type: "trigger_infra", id: null });
      expect(context.credential).toMatchObject({ kind: "oat", id: row.id, last4: token.slice(-4) });
    }
  );

  // Catches: tagging every org token as infrastructure, hiding a customer's own token.
  postgresTest("records a user token as the actor", async ({ prisma }) => {
    db.client = prisma;
    const { token, row } = await createToken(prisma, "USER");

    const context = await auditContextFor(token);

    expect(context.actor).toEqual({ type: "oat", id: row.id });
    expect(context.credential).toMatchObject({ kind: "oat", id: row.id, last4: token.slice(-4) });
  });
});
