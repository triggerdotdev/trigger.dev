import type { DashboardAgentDb } from "@internal/dashboard-agent-db";
import { describe, expect, it } from "vitest";
import {
  isDashboardAgentQuotaEnabled,
  recordAgentMessageSent,
  resolveAgentMessageQuota,
  UNLIMITED_AGENT_MESSAGES,
} from "~/services/dashboardAgentQuota.server";

/**
 * The dashboard agent is free for now (TRI-12863): DASHBOARD_AGENT_QUOTA_ENABLED defaults to
 * "0", and here it is unset entirely, so both quota entry points must fail open without
 * touching the billing limit lookup or the usage counter.
 */

describe("when the quota flag is off", () => {
  it("is off by default", () => {
    expect(isDashboardAgentQuotaEnabled()).toBe(false);
  });

  it("resolves unlimited without calling the limit lookup or the usage counter", async () => {
    const untouchedDb = new Proxy(
      {},
      {
        get() {
          throw new Error("must not touch the dashboard agent db when the quota is off");
        },
      }
    ) as DashboardAgentDb;

    const result = await resolveAgentMessageQuota(untouchedDb, {
      organizationId: "org_quota_disabled",
      readLimit: async () => {
        throw new Error("must not read the billing limit when the quota is off");
      },
    });

    expect(result).toEqual({ reached: false, used: 0, limit: UNLIMITED_AGENT_MESSAGES });
  });

  it("does not record a sent message", async () => {
    // recordAgentMessageSent swallows errors, so a throwing proxy would prove nothing here —
    // record access instead and assert the db was never touched.
    let touched = false;
    const untouchedDb = new Proxy(
      {},
      {
        get() {
          touched = true;
          return undefined;
        },
      }
    ) as DashboardAgentDb;

    await recordAgentMessageSent(untouchedDb, { organizationId: "org_quota_disabled" });

    expect(touched).toBe(false);
  });
});
