// Comprehensive dashboard session-auth tests — see TRI-8742.
// Each test seeds a User + session cookie via seedTestUser / seedTestSession
// (helpers/seedTestSession.ts) and hits the shared webapp container.

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestSession, seedTestUser } from "./helpers/seedTestSession";

describe("Dashboard", () => {
  it("shared webapp container redirects /admin/feature-flags to /login when unauthenticated", async () => {
    const server = getTestServer();
    const res = await server.webapp.fetch("/admin/feature-flags", { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  // Admin pages migrated to dashboardLoader({ authorization: { requireSuper: true } })
  // in TRI-8717. The dashboardLoader resolves auth in three stages:
  //   1. No session → redirect to /login?redirectTo=<path>.
  //   2. Session, user.admin === false → redirect to / (no path leakage).
  //   3. Session, user.admin === true → run the loader handler.
  //
  // Coverage strategy: pick three representative routes (the index, a
  // tabbed sub-page, and the back-office tree) rather than all 14 —
  // they all share the same dashboardLoader config so testing every
  // file would just confirm the wrapper works, which the harness
  // already proves. If the wrapper config drifts per-route in the
  // future, add targeted tests for the divergent ones.
  describe("Admin pages — requireSuper gate", () => {
    const adminRoutes = ["/admin", "/admin/feature-flags", "/admin/back-office"];

    for (const path of adminRoutes) {
      describe(`GET ${path}`, () => {
        it("no session: redirects to /login?redirectTo=<path>", async () => {
          const server = getTestServer();
          const res = await server.webapp.fetch(path, { redirect: "manual" });
          expect(res.status).toBe(302);
          const location = res.headers.get("location") ?? "";
          expect(location).toContain("/login");
          // Path leaks deliberately so a successful login bounces the
          // user back to where they were headed.
          expect(location).toContain(`redirectTo=${encodeURIComponent(path)}`);
        });

        it("session for non-admin user: redirects to / (no path leakage)", async () => {
          const server = getTestServer();
          const user = await seedTestUser(server.prisma, { admin: false });
          const cookie = await seedTestSession({ userId: user.id });
          const res = await server.webapp.fetch(path, {
            redirect: "manual",
            headers: { Cookie: cookie },
          });
          expect(res.status).toBe(302);
          const location = res.headers.get("location") ?? "";
          // unauthorizedRedirect default in dashboardBuilder is "/".
          // A non-admin landing on /admin shouldn't get redirectTo
          // back to /admin once they upgrade — they're not getting in
          // by re-auth.
          expect(new URL(location, "http://localhost").pathname).toBe("/");
        });

        it("session for admin user: 2xx", async () => {
          const server = getTestServer();
          const user = await seedTestUser(server.prisma, { admin: true });
          const cookie = await seedTestSession({ userId: user.id });
          const res = await server.webapp.fetch(path, {
            redirect: "manual",
            headers: { Cookie: cookie },
          });
          // Loader handler ran — could be 200 (HTML) or 204 (Remix
          // _data fetch). Either way, NOT a redirect.
          expect(res.status).toBeLessThan(300);
        });
      });
    }
  });

  // Action handlers behind requireSuper used to return 403 Unauthorized
  // pre-RBAC — now they redirect to / via dashboardAction's
  // unauthorizedRedirect. The ticket flagged this as a behaviour
  // change worth locking in (any XHR fetcher that branched on 403
  // would have regressed silently). Use admin.feature-flags POST as
  // the canary — it's the simplest action of the bunch.
  describe("Admin action — requireSuper gate (admin.feature-flags POST)", () => {
    const path = "/admin/feature-flags";

    it("no session: redirects to /login (POST)", async () => {
      const server = getTestServer();
      const res = await server.webapp.fetch(path, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("/login");
    });

    it("session for non-admin user: redirects to / (was 403 pre-RBAC)", async () => {
      const server = getTestServer();
      const user = await seedTestUser(server.prisma, { admin: false });
      const cookie = await seedTestSession({ userId: user.id });
      const res = await server.webapp.fetch(path, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json", Cookie: cookie },
        redirect: "manual",
      });
      // Behaviour change from the TRI-8717 migration: the legacy
      // path returned 403 Unauthorized; dashboardAction returns a
      // 302 to "/" instead. Any client code branching on 403 needs
      // updating — locking this in so a silent regression is loud.
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(new URL(location, "http://localhost").pathname).toBe("/");
    });
  });

  // Cross-tenant tenant floor on org settings routes. settings/roles is the case
  // the route-level membership scoping (SSO/Team) did NOT cover, so it exercises
  // the RBAC fallback's org-membership floor specifically: the fallback ability
  // is permissive (can: () => true), so that floor is the only thing stopping a
  // non-member from reading the org's role and permission catalogue.
  //
  // The request hits the route's own loader directly via Remix's `?_data`, which
  // is the exact exploit shape: a plain document GET 404s at the org layout
  // (membership) and never reaches this leaf, so it wouldn't test the leaf floor.
  // Both users have confirmedBasicDetails set so the `_app` onboarding redirect
  // can't stand in for the deny.
  describe("Org settings — cross-tenant tenant floor (settings/roles)", () => {
    const ROLES_ROUTE_ID = "routes/_app.orgs.$organizationSlug.settings.roles";
    const rolesData = (slug: string) =>
      `/orgs/${slug}/settings/roles?_data=${encodeURIComponent(ROLES_ROUTE_ID)}`;

    async function seedConfirmedUser(prisma: PrismaClient) {
      const user = await seedTestUser(prisma);
      await prisma.user.update({ where: { id: user.id }, data: { confirmedBasicDetails: true } });
      return user;
    }

    async function seedOrgWithOwner() {
      const server = getTestServer();
      const owner = await seedConfirmedUser(server.prisma);
      const org = await server.prisma.organization.create({
        data: {
          title: "E2E tenant-floor org",
          slug: `e2e-tenant-${randomBytes(6).toString("hex")}`,
          members: { create: { userId: owner.id, role: "ADMIN" } },
        },
      });
      return { server, owner, org };
    }

    it("denies a non-member: no roles catalogue leaked", async () => {
      const { server, org } = await seedOrgWithOwner();
      const outsider = await seedConfirmedUser(server.prisma);
      const cookie = await seedTestSession({ userId: outsider.id });
      const res = await server.webapp.fetch(rolesData(org.slug), {
        redirect: "manual",
        headers: { Cookie: cookie },
      });
      const body = await res.text();
      // With the tenant floor a non-member is denied (a redirect), so they never
      // get the loader's 200 payload. Before the fix the permissive ability let
      // the loader return the org's role/permission catalogue.
      expect(res.status).not.toBe(200);
      expect(body).not.toContain("manage:members");
    });

    it("allows a member: the loader returns the catalogue", async () => {
      const { server, owner, org } = await seedOrgWithOwner();
      const cookie = await seedTestSession({ userId: owner.id });
      const res = await server.webapp.fetch(rolesData(org.slug), {
        redirect: "manual",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });
  });
});
