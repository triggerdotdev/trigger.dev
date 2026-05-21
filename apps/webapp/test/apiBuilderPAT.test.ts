// Integration test for `createLoaderPATApiRoute` — confirms PAT-authenticated
// requests stamp `userId` onto the tenant context (so Sentry events from
// PAT routes get user-level attribution).
//
// Runs against the local postgres the webapp test setup already targets
// (`apps/webapp/.env` → `DATABASE_URL`). Seeds a real User + PersonalAccessToken
// via Prisma, calls the real loader with the real bearer, and lets
// `rbac.authenticatePat` validate against the DB end-to-end. No stubs.
//
// Cleans up the rows it creates so the test is repeatable.

import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../app/db.server";
import { createPersonalAccessToken } from "../app/services/personalAccessToken.server";
import { tenantContext } from "../app/services/tenantContext.server";
import { createLoaderPATApiRoute } from "../app/services/routeBuilders/apiBuilder.server";

const cleanup: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const fn of cleanup) {
    await fn().catch(() => {});
  }
});

describe("createLoaderPATApiRoute", () => {
  it("enriches tenant context with the authenticated PAT's userId", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        email: `pat-tenant-test-${suffix}@test.local`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
    cleanup.push(async () => {
      await prisma.personalAccessToken.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    const created = await createPersonalAccessToken({
      name: `pat-tenant-test-${suffix}`,
      userId: user.id,
    });

    let observedUserId: string | undefined;
    const loader = createLoaderPATApiRoute({}, async () => {
      observedUserId = tenantContext.get()?.userId;
      return new Response(null, { status: 200 });
    });

    await tenantContext.run({}, async () => {
      await loader({
        request: new Request("http://localhost/api/test", {
          headers: { Authorization: `Bearer ${created.token}` },
        }),
        params: {},
        context: {},
      });
    });

    expect(observedUserId).toBe(user.id);
  });

  it("does not leave the enrich behind once the request scope ends", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        email: `pat-tenant-leak-${suffix}@test.local`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
    cleanup.push(async () => {
      await prisma.personalAccessToken.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    });

    const created = await createPersonalAccessToken({
      name: `pat-tenant-leak-${suffix}`,
      userId: user.id,
    });

    const loader = createLoaderPATApiRoute({}, async () => new Response(null, { status: 200 }));

    await tenantContext.run({}, async () => {
      await loader({
        request: new Request("http://localhost/api/test", {
          headers: { Authorization: `Bearer ${created.token}` },
        }),
        params: {},
        context: {},
      });
    });

    expect(tenantContext.get()).toBeUndefined();
  });
});
