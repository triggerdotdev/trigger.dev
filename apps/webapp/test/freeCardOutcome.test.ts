import { describe, expect, it } from "vitest";
import { freeCardOutcomeRedirect } from "~/services/freeCardStep.server";

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

  // Catches: text from the URL's reason parameter reaching the toast.
  it("only shows messages for reasons it knows", () => {
    const known = freeCardOutcomeRedirect(org, "failed", "card_not_verified").message;
    const unknown = freeCardOutcomeRedirect(org, "failed", "<b>hi</b>").message;
    expect(unknown).not.toContain("<b>");
    expect(unknown).not.toBe(known);
  });
});
