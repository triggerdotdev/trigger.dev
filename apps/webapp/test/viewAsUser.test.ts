import { describe, expect, it } from "vitest";
import {
  clearImpersonationId,
  commitImpersonationSession,
  getImpersonationId,
  getImpersonationState,
  setImpersonationId,
  setViewingAsUser,
} from "~/services/impersonation.server";
import { hasAdminDisplayAccess } from "~/services/session.server";
import type { Session } from "@remix-run/node";

// `commitSession` returns a full Set-Cookie value; a request only needs the
// name=value pair back.
async function requestWith(session: Session) {
  const setCookie = await commitImpersonationSession(session);
  return new Request("http://localhost:3030/orgs/acme", {
    headers: { Cookie: setCookie.split(";")[0] },
  });
}

// Reads the flag the way a request does: against the user the request resolved
// as. Every fixture below impersonates `user_1`.
async function readViewingAsUser(request: Request) {
  return (await getImpersonationState(request, "user_1")).isViewingAsUser;
}

// The "view as user" flag rides on the impersonation cookie, so it is scoped to
// the impersonation session by construction.
describe("view as user flag", () => {
  it("is off when there is no impersonation cookie", async () => {
    expect(await readViewingAsUser(new Request("http://localhost:3030/orgs/acme"))).toBe(false);
  });

  it("can be turned on and back off within an impersonation session", async () => {
    const start = new Request("http://localhost:3030/orgs/acme");

    const impersonating = await requestWith(await setImpersonationId("user_1", start));
    expect(await getImpersonationId(impersonating)).toBe("user_1");
    expect(await readViewingAsUser(impersonating)).toBe(false);

    const viewingAsUser = await requestWith(await setViewingAsUser(true, impersonating));
    expect(await getImpersonationId(viewingAsUser)).toBe("user_1");
    expect(await readViewingAsUser(viewingAsUser)).toBe(true);

    const showingAdminUi = await requestWith(await setViewingAsUser(false, viewingAsUser));
    expect(await getImpersonationId(showingAdminUi)).toBe("user_1");
    expect(await readViewingAsUser(showingAdminUi)).toBe(false);
  });

  it("is dropped when impersonation is cleared", async () => {
    const start = new Request("http://localhost:3030/orgs/acme");
    const impersonating = await requestWith(await setImpersonationId("user_1", start));
    const viewingAsUser = await requestWith(await setViewingAsUser(true, impersonating));

    const cleared = await requestWith(await clearImpersonationId(viewingAsUser));

    expect(await getImpersonationId(cleared)).toBeUndefined();
    expect(await readViewingAsUser(cleared)).toBe(false);
  });

  it("never reads as on without an impersonated user", async () => {
    const start = new Request("http://localhost:3030/orgs/acme");
    // Set the flag with no impersonation in progress — it must not read back on.
    const flagOnly = await requestWith(await setViewingAsUser(true, start));

    expect(await readViewingAsUser(flagOnly)).toBe(false);
  });

  it("is off once the impersonated user is not who the request resolved as", async () => {
    const start = new Request("http://localhost:3030/orgs/acme");
    const impersonating = await requestWith(await setImpersonationId("user_1", start));
    const viewing = await requestWith(await setViewingAsUser(true, impersonating));

    // An admin who loses the admin role mid-session resolves back to their own
    // id while the cookie still names the target. That session is not
    // impersonating any more, so it is not viewing as the user either.
    const state = await getImpersonationState(viewing, "admin_1");

    expect(state.isImpersonating).toBe(false);
    expect(state.isViewingAsUser).toBe(false);
  });
});

describe("hasAdminDisplayAccess", () => {
  it("shows admin UI to admins and to impersonating sessions", () => {
    expect(
      hasAdminDisplayAccess({ admin: true, isImpersonating: false, isViewingAsUser: false })
    ).toBe(true);
    expect(
      hasAdminDisplayAccess({ admin: false, isImpersonating: true, isViewingAsUser: false })
    ).toBe(true);
  });

  it("hides admin UI to everyone else", () => {
    expect(
      hasAdminDisplayAccess({ admin: false, isImpersonating: false, isViewingAsUser: false })
    ).toBe(false);
  });

  it("hides admin UI while viewing as the user", () => {
    expect(
      hasAdminDisplayAccess({ admin: true, isImpersonating: true, isViewingAsUser: true })
    ).toBe(false);
    expect(
      hasAdminDisplayAccess({ admin: false, isImpersonating: true, isViewingAsUser: true })
    ).toBe(false);
  });
});
