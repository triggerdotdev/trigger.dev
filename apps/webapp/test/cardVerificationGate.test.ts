import type { PrismaClient } from "@trigger.dev/database";
import type { DeploymentAccessController } from "@trigger.dev/plugins";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import {
  decideCardVerificationGate,
  hasActiveDeployAccessOverride,
  resolveCardVerificationGate,
} from "~/v3/cardVerificationGate.server";

vi.setConfig({ testTimeout: 60_000 });

const requiredFrom = new Date("2026-11-01T00:00:00Z");
const config = { enabled: true, requiredFrom };

describe("decideCardVerificationGate", () => {
  const gate = (overrides: Partial<Parameters<typeof decideCardVerificationGate>[0]> = {}) =>
    decideCardVerificationGate({
      config,
      organizationCreatedAt: new Date("2026-11-02T00:00:00Z"),
      planType: "free",
      verification: { supported: true, verified: false },
      ...overrides,
    });

  // Catches: an off-by-one at the cutoff, or an unset cutoff leaving every org ungated.
  it("gates from the cutoff on, and every org without one", () => {
    expect(gate({ organizationCreatedAt: requiredFrom })).toBe("gated");
    const older = new Date("2026-10-31T23:59:59Z");
    expect(gate({ organizationCreatedAt: older })).toBe("not_gated");
    expect(
      gate({ organizationCreatedAt: older, config: { enabled: true, requiredFrom: undefined } })
    ).toBe("gated");
  });

  // Catches: a paying org, or one billing can't verify a card for, being blocked from deploying.
  it("never gates paid orgs, verified cards, or orgs billing can't verify", () => {
    for (const planType of ["paid", "enterprise", "not_configured"] as const) {
      expect(gate({ planType })).toBe("not_gated");
    }
    expect(gate({ verification: { supported: true, verified: true } })).toBe("not_gated");
    expect(gate({ verification: { supported: false, verified: false } })).toBe("not_gated");
  });

  // Catches: a billing outage reading as "gated", which would show the banner to every Free org.
  it("says unknown when billing can't be read", () => {
    expect(gate({ planType: undefined })).toBe("unknown");
    expect(gate({ verification: null })).toBe("unknown");
  });
});

describe("resolveCardVerificationGate", () => {
  async function createOrg(prisma: PrismaClient, createdAt: Date) {
    const slug = `card-gate-${Math.random().toString(36).slice(2, 10)}`;
    return prisma.organization.create({ data: { slug, title: slug, createdAt } });
  }

  const free = {
    config,
    planType: async () => "free" as const,
    cardVerification: async () => ({ supported: true, verified: false }),
    hasActiveOverride: async () => false,
  };

  // Catches: the gate calling billing for orgs it can never block, adding a billing call to every
  // page load of an old org.
  postgresTest("asks billing nothing outside the cohort", async ({ prisma }) => {
    const org = await createOrg(prisma, new Date("2026-10-01T00:00:00Z"));
    const planType = vi.fn(free.planType);
    expect(await resolveCardVerificationGate(org.id, { ...free, client: prisma, planType })).toBe(
      "not_gated"
    );
    expect(
      await resolveCardVerificationGate(org.id, {
        ...free,
        client: prisma,
        planType,
        config: { enabled: false, requiredFrom: undefined },
      })
    ).toBe("not_gated");
    expect(planType).not.toHaveBeenCalled();
  });

  // Catches: an org with an active deploy access override still being card-gated, or the override
  // lookup running for paid orgs.
  postgresTest("leaves an org with an active override to the override", async ({ prisma }) => {
    const org = await createOrg(prisma, new Date("2026-11-02T00:00:00Z"));
    expect(await resolveCardVerificationGate(org.id, { ...free, client: prisma })).toBe("gated");

    const hasActiveOverride = vi.fn(async () => true);
    expect(
      await resolveCardVerificationGate(org.id, { ...free, client: prisma, hasActiveOverride })
    ).toBe("not_gated");

    hasActiveOverride.mockClear();
    await resolveCardVerificationGate(org.id, {
      ...free,
      client: prisma,
      planType: async () => "paid",
      hasActiveOverride,
    });
    expect(hasActiveOverride).not.toHaveBeenCalled();
  });

  // Catches: a failed billing or override read gating the org instead of failing open.
  postgresTest("says unknown when a lookup throws", async ({ prisma }) => {
    const org = await createOrg(prisma, new Date("2026-11-02T00:00:00Z"));
    const down = async (): Promise<never> => {
      throw new Error("down");
    };
    for (const broken of [
      { planType: down },
      { cardVerification: down },
      { hasActiveOverride: down },
    ]) {
      expect(
        await resolveCardVerificationGate(org.id, { ...free, client: prisma, ...broken })
      ).toBe("unknown");
    }
  });
});

describe("resolveCardVerificationGate when the database fails", () => {
  // Catches: a failed organization read throwing out of the gate, which turns a deploy into a 500
  // instead of letting it through.
  it("says unknown", async () => {
    const client = {
      organization: {
        findFirst: async () => {
          throw new Error("database unavailable");
        },
      },
    } as unknown as PrismaClient;
    const planType = vi.fn(async () => "free" as const);
    expect(await resolveCardVerificationGate("org_1", { config, client, planType })).toBe(
      "unknown"
    );
    expect(planType).not.toHaveBeenCalled();
  });
});

describe("hasActiveDeployAccessOverride", () => {
  const controller =
    (hasActiveOverride?: DeploymentAccessController["hasActiveOverride"]) => async () => ({
      checkDeploy: vi.fn(),
      integrationAccess: vi.fn(),
      hasActiveOverride,
    });

  // Catches: OSS, or a plugin built before the method existed, throwing instead of reporting no
  // override.
  it("reports no override without the plugin or the method", async () => {
    expect(await hasActiveDeployAccessOverride("org_1", async () => null)).toBe(false);
    expect(await hasActiveDeployAccessOverride("org_1", controller())).toBe(false);
    expect(
      await hasActiveDeployAccessOverride(
        "org_1",
        controller(async () => true)
      )
    ).toBe(true);
  });
});
