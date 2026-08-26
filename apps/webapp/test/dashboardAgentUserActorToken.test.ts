import { verifyUserActorToken } from "@trigger.dev/rbac";
import { describe, expect, it, vi } from "vitest";

// The db client is a module side effect of the mint's module, not part of what is under test.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {}, sqlDatabaseSchema: undefined }));

const SESSION_SECRET = "test-session-secret-for-user-actor-tokens";
process.env.SESSION_SECRET = SESSION_SECRET;

const { DASHBOARD_AGENT_UAT_CAP, mintDashboardAgentUserActorToken } =
  await import("~/services/dashboardAgent.server");

describe("the dashboard agent's delegated token", () => {
  it("carries the organization as well as the environment", async () => {
    const token = await mintDashboardAgentUserActorToken("user_1", {
      environmentId: "env_1",
      organizationId: "org_1",
    });

    const claims = await verifyUserActorToken(SESSION_SECRET, token);
    expect(claims?.userId).toBe("user_1");
    expect(claims?.client).toBe("dashboard-agent");
    // Both scopes ride on every mint: the org is the authorization boundary, the
    // environment the conversational default.
    expect(claims?.environmentId).toBe("env_1");
    expect(claims?.organizationId).toBe("org_1");
    expect(claims?.cap).toEqual(DASHBOARD_AGENT_UAT_CAP);
  });
});
