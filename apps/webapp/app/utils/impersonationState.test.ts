import { describe, expect, it } from "vitest";
import { resolveImpersonationState } from "./impersonationState";

const IMPERSONATED = "user_1";
const ADMIN = "admin_1";

describe("resolveImpersonationState", () => {
  it("reports impersonation when the cookie's id is the resolved user", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: undefined,
        resolvedUserId: IMPERSONATED,
      })
    ).toEqual({ isImpersonating: true, isViewingAsUser: false });
  });

  it("carries the view-as-user flag inside an impersonation session", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: true,
        resolvedUserId: IMPERSONATED,
      })
    ).toEqual({ isImpersonating: true, isViewingAsUser: true });
  });

  // The case the strict comparison exists for: the session falls back to the
  // real admin's id when their admin role is revoked mid-session, while the
  // cookie still names the impersonation target. Both flags must read false so
  // the server-side values and the value published to the client agree.
  it("reports neither flag when the impersonated id is not the resolved user", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: true,
        resolvedUserId: ADMIN,
      })
    ).toEqual({ isImpersonating: false, isViewingAsUser: false });
  });

  it("reports neither flag when there is no impersonated id", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: undefined,
        viewingAsUser: true,
        resolvedUserId: IMPERSONATED,
      })
    ).toEqual({ isImpersonating: false, isViewingAsUser: false });
  });

  it("reports neither flag when there is no resolved user", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: true,
        resolvedUserId: undefined,
      })
    ).toEqual({ isImpersonating: false, isViewingAsUser: false });
  });

  it("only treats a literal true as the view-as-user flag", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: "true",
        resolvedUserId: IMPERSONATED,
      }).isViewingAsUser
    ).toBe(false);
  });
});
