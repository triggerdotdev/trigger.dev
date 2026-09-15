import { describe, expect, it } from "vitest";
import { isAtOrBelow } from "../app/utils/inviteRoleLadder.js";

// systemRoles in canonical order: highest authority first.
const roles = [{ id: "owner" }, { id: "admin" }, { id: "member" }];

// Property under test: an inviter can only assign a role at or below their own,
// and a roleless inviter can assign nothing.
describe("isAtOrBelow", () => {
  it("lets an inviter assign a role below their own", () => {
    expect(isAtOrBelow(roles, "owner", "admin")).toBe(true);
    expect(isAtOrBelow(roles, "admin", "member")).toBe(true);
  });

  it("lets an inviter assign their own level", () => {
    expect(isAtOrBelow(roles, "admin", "admin")).toBe(true);
  });

  it("refuses assigning a role above the inviter's", () => {
    expect(isAtOrBelow(roles, "admin", "owner")).toBe(false);
    expect(isAtOrBelow(roles, "member", "admin")).toBe(false);
  });

  it("refuses a roleless inviter outright — the privilege-escalation vector", () => {
    expect(isAtOrBelow(roles, null, "owner")).toBe(false);
    expect(isAtOrBelow(roles, null, "member")).toBe(false);
  });

  it("refuses unknown / custom roles not on the ladder", () => {
    expect(isAtOrBelow(roles, "owner", "custom-role-id")).toBe(false);
    expect(isAtOrBelow(roles, "custom-role-id", "member")).toBe(false);
  });
});
