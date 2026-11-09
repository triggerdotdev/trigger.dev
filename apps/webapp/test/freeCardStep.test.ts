import { describe, expect, it, vi } from "vitest";
import type { CardVerification } from "~/services/cardVerification.schemas";
import { needsCardStep, routeFreePlanToCardStep } from "~/services/freeCardStep.server";
import type { GatePlanType } from "~/v3/cardVerificationGate.server";

const org = { id: "org_1", slug: "acme", createdAt: new Date("2026-11-05T12:00:00Z") };
const unverified: CardVerification = { supported: true, verified: false };

function redirectTo(location: string) {
  const response = new Response(null, { status: 302, headers: { Location: location } });
  response.headers.append("Set-Cookie", "promo=; Max-Age=0");
  return response;
}

function deps({
  verification = unverified as CardVerification | null,
  gate = { enabled: true, requiredFrom: undefined as Date | undefined },
  planType = async (): Promise<GatePlanType> => "free",
  hasActiveOverride = async () => false,
} = {}) {
  return {
    getCardVerification: vi.fn(async (_organizationId: string) => verification),
    gateConfig: () => gate,
    planType: vi.fn(planType),
    hasActiveOverride: vi.fn(hasActiveOverride),
  };
}

describe("routeFreePlanToCardStep", () => {
  // Catches: the card step redirect replacing the response and dropping cookies set by the plan
  // change, or firing when the plan change itself failed.
  it("redirects a provisioned Free org to the card step and keeps its cookies", async () => {
    const response = await routeFreePlanToCardStep(
      redirectTo("/orgs/acme/projects/new?message=You%27re%20on%20the%20Free%20plan."),
      org,
      deps()
    );
    expect(response.headers.get("Location")).toBe("/orgs/acme/select-plan/card");
    expect(response.headers.get("Set-Cookie")).toContain("promo=");

    const failed = deps();
    const unchanged = await routeFreePlanToCardStep(
      redirectTo("/orgs/acme/select-plan"),
      org,
      failed
    );
    expect(unchanged.headers.get("Location")).toBe("/orgs/acme/select-plan");
    expect(failed.getCardVerification).not.toHaveBeenCalled();
  });
});

describe("needsCardStep", () => {
  // Catches: the card step opening for an org the gate would never block, which would send it
  // through a pointless checkout.
  it("is false wherever the gate wouldn't block deploys", async () => {
    const cases = [
      deps({ gate: { enabled: false, requiredFrom: undefined } }),
      deps({ gate: { enabled: true, requiredFrom: new Date("2026-11-06T00:00:00Z") } }),
      deps({
        verification: { supported: true, verified: true, verifiedAt: "2026-11-05T12:00:00.000Z" },
      }),
      deps({ verification: { supported: false, verified: false } }),
      deps({ hasActiveOverride: async () => true }),
    ];
    for (const d of cases) expect(await needsCardStep(org, d)).toBe(false);
    expect(await needsCardStep(org, deps())).toBe(true);
  });

  // Catches: a paid org reaching the Free card checkout, which would move its invoice card.
  it("is false for an org that isn't on the Free plan", async () => {
    const d = deps({ planType: async () => "paid" });
    expect(await needsCardStep(org, d)).toBe(false);
    expect(d.getCardVerification).not.toHaveBeenCalled();
  });

  // Catches: a billing or override outage blocking project creation behind the card step.
  it("is false when a lookup fails", async () => {
    const down = async (): Promise<never> => {
      throw new Error("down");
    };
    expect(await needsCardStep(org, deps({ planType: down }))).toBe(false);
    expect(await needsCardStep(org, deps({ hasActiveOverride: down }))).toBe(false);
    expect(await needsCardStep(org, deps({ verification: null }))).toBe(false);
  });
});
