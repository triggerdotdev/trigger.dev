import { beforeEach, describe, expect, it, vi } from "vitest";

const STATE = vi.hoisted(() => ({ member: true, flag: false, admin: false, configured: "1" }));

vi.mock("~/env.server", () => ({
  env: {
    get ALERTS_ENABLED() {
      return STATE.configured;
    },
  },
}));
vi.mock("~/v3/featureFlags.server", () => ({ makeFlag: () => async () => STATE.flag }));
vi.mock("~/db.server", () => ({
  prisma: { user: { findFirst: async () => ({ admin: STATE.admin }) } },
  $replica: {
    organization: {
      findFirst: async ({ where }: { where: { members?: unknown } }) =>
        where.members && !STATE.member ? null : { featureFlags: {} },
    },
  },
}));

import {
  requireAlertsEnabledOrForbid,
  requireAlertsEnabledOrRedirect,
} from "~/v3/canUseAlertsList.server";

const params = { organizationSlug: "o", projectParam: "p", envParam: "dev" };

async function thrown(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e as Response;
  }
  return undefined;
}

beforeEach(() => {
  STATE.member = true;
  STATE.flag = false;
  STATE.admin = false;
  STATE.configured = "1";
});

describe.each([
  ["redirect", () => requireAlertsEnabledOrRedirect("u", params), 302],
  ["forbid", () => requireAlertsEnabledOrForbid("u", "o"), 403],
] as const)("requireAlertsEnabledOr %s", (_name, run, deniedStatus) => {
  it("denies a member with the flag off", async () => {
    expect((await thrown(run))?.status).toBe(deniedStatus);
  });

  it("allows a member with the flag on", async () => {
    STATE.flag = true;
    expect(await thrown(run)).toBeUndefined();
  });

  it("allows an admin member with the flag off when alerts are configured", async () => {
    STATE.admin = true;
    expect(await thrown(run)).toBeUndefined();
  });

  it("denies an admin member with the flag off when alerts are not configured", async () => {
    STATE.admin = true;
    STATE.configured = "";
    expect((await thrown(run))?.status).toBe(deniedStatus);
  });

  it("denies a non-member even with the flag on", async () => {
    STATE.member = false;
    STATE.flag = true;
    expect((await thrown(run))?.status).toBe(deniedStatus);
  });
});
