import { describe, expect, it } from "vitest";
import { isAtOrBelow, offerableRoleIds } from "../app/utils/inviteRoleLadder.js";

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

// Property under test: the picker set is the catalogue minus the roles the
// ladder puts strictly above the viewer. Nothing else is removed — roles with
// no ladder position (org-defined custom roles) stay offerable, and so does
// the whole catalogue when the viewer's own role has no position either.
// Plan gating is a separate concern the caller layers on, so a plan-locked
// role must still come back here — the Team page renders it as an upgrade link.
describe("offerableRoleIds", () => {
  const catalogue = [{ id: "owner" }, { id: "admin" }, { id: "member" }, { id: "custom-1" }];

  it("offers the viewer's own level and below", () => {
    expect(offerableRoleIds(catalogue, roles, "admin")).toEqual(["admin", "member", "custom-1"]);
    expect(offerableRoleIds(catalogue, roles, "member")).toEqual(["member", "custom-1"]);
  });

  it("leaves roles above the viewer out entirely", () => {
    expect(offerableRoleIds(catalogue, roles, "admin")).not.toContain("owner");
    expect(offerableRoleIds(catalogue, roles, "member")).not.toContain("owner");
    expect(offerableRoleIds(catalogue, roles, "member")).not.toContain("admin");
  });

  it("offers the whole catalogue to a viewer at the top of the ladder", () => {
    expect(offerableRoleIds(catalogue, roles, "owner")).toEqual([
      "owner",
      "admin",
      "member",
      "custom-1",
    ]);
  });

  it("does not filter on plan gating — a plan-locked role is still offerable", () => {
    // `owner` may be unavailable on the org's plan; that is the caller's
    // concern, and it still needs the id back to render the upgrade row.
    expect(offerableRoleIds(catalogue, roles, "owner")).toContain("owner");
  });

  it("keeps custom roles, which the ladder can't place above anyone", () => {
    expect(offerableRoleIds(catalogue, roles, "owner")).toContain("custom-1");
    expect(offerableRoleIds(catalogue, roles, "admin")).toContain("custom-1");
    expect(offerableRoleIds(catalogue, roles, "member")).toContain("custom-1");
  });

  it("does not narrow at all for a viewer holding a custom role", () => {
    // The ladder can't say what is above a role it doesn't list, so leave the
    // picker as it was rather than emptying it and stranding the viewer.
    expect(offerableRoleIds(catalogue, roles, "custom-1")).toEqual([
      "owner",
      "admin",
      "member",
      "custom-1",
    ]);
  });

  it("does not narrow at all for a roleless viewer or with no ladder", () => {
    expect(offerableRoleIds(catalogue, roles, null)).toEqual([
      "owner",
      "admin",
      "member",
      "custom-1",
    ]);
    expect(offerableRoleIds(catalogue, null, "owner")).toEqual([
      "owner",
      "admin",
      "member",
      "custom-1",
    ]);
  });
});
