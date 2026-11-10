import { describe, expect, it } from "vitest";
import { freeCardStepPath, parseFreeCardReturnTo } from "~/components/billing/freeCardStepPath";
import { freeCardDonePath, freeCardOutcomeRedirect } from "~/services/freeCardStep.server";

const org = { slug: "acme" };

describe("freeCardOutcomeRedirect", () => {
  // Catches: a verified org landing back on the card step, or a canceled or failed checkout
  // landing on project creation without a way to retry.
  it("sends a verified card to project creation and anything else back to the card step", () => {
    expect(freeCardOutcomeRedirect(org, "complete", null)).toMatchObject({
      kind: "success",
      path: "/orgs/acme/projects/new",
    });
    for (const outcome of ["canceled", "failed"] as const) {
      expect(freeCardOutcomeRedirect(org, outcome, null)).toMatchObject({
        kind: "error",
        path: "/orgs/acme/select-plan/card",
      });
    }
  });

  // Catches: verifying from the banner or Billing dropping the user on project creation, or a
  // retry from there losing the way back to Billing.
  it("sends a card verified from Billing back to Billing, and a retry keeps the target", () => {
    expect(freeCardOutcomeRedirect(org, "complete", null, "billing")).toMatchObject({
      kind: "success",
      path: "/orgs/acme/settings/billing",
    });
    for (const outcome of ["canceled", "failed"] as const) {
      expect(freeCardOutcomeRedirect(org, outcome, null, "billing")).toMatchObject({
        kind: "error",
        path: "/orgs/acme/select-plan/card?returnTo=billing",
      });
    }
  });

  // Catches: skipping, or opening the step once a card is verified, ignoring the return target.
  it("hands over to Billing or project creation by return target", () => {
    expect(freeCardDonePath(org, "billing")).toBe("/orgs/acme/settings/billing");
    expect(freeCardDonePath(org)).toBe("/orgs/acme/projects/new");
    expect(freeCardStepPath(org)).toBe("/orgs/acme/select-plan/card");
  });

  // Catches: a cookie or query value other than a known target picking where the user lands.
  it("only accepts known return targets", () => {
    expect(parseFreeCardReturnTo("billing")).toBe("billing");
    for (const value of ["https://evil.example", "", undefined, null, 1]) {
      expect(parseFreeCardReturnTo(value)).toBeUndefined();
    }
  });

  // Catches: text from the URL's reason parameter reaching the toast.
  it("only shows messages for reasons it knows", () => {
    const known = freeCardOutcomeRedirect(org, "failed", "card_not_verified").message;
    const unknown = freeCardOutcomeRedirect(org, "failed", "<b>hi</b>").message;
    expect(unknown).not.toContain("<b>");
    expect(unknown).not.toBe(known);
  });
});
