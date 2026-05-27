// Produces a `Cookie:` header value for an authenticated session that the
// webapp under test will accept. Mirrors the webapp's
// `services/sessionStorage.server.ts` config exactly — the SESSION_SECRET
// must match what the webapp container was started with (see
// `internal-packages/testcontainers/src/webapp.ts` — currently
// "test-session-secret-for-e2e-tests").
//
// Used by dashboard auth tests (TRI-8742). Each test seeds its own user +
// session so test order doesn't matter.

import { createCookieSessionStorage } from "@remix-run/node";
import type { PrismaClient } from "@trigger.dev/database";
import { randomBytes } from "node:crypto";

// Must match SESSION_SECRET in internal-packages/testcontainers/src/webapp.ts.
const SESSION_SECRET = "test-session-secret-for-e2e-tests";

// Shape of the session config in apps/webapp/app/services/sessionStorage.server.ts.
const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__session",
    sameSite: "lax",
    path: "/",
    httpOnly: true,
    secrets: [SESSION_SECRET],
    secure: false, // NODE_ENV is "test" in the spawned webapp.
    maxAge: 60 * 60 * 24 * 365,
  },
});

export async function seedTestUser(
  prisma: PrismaClient,
  overrides?: { admin?: boolean; email?: string }
) {
  const suffix = randomBytes(6).toString("hex");
  return prisma.user.create({
    data: {
      email: overrides?.email ?? `e2e-${suffix}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      admin: overrides?.admin ?? false,
    },
  });
}

// Builds the `Cookie:` header value for a given user. Set this on test
// requests to the webapp to authenticate as that user.
//
// remix-auth's default sessionKey is "user" and stores AuthUser as
// { userId } — see apps/webapp/app/services/authUser.ts.
export async function seedTestSession(opts: { userId: string }): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set("user", { userId: opts.userId });
  const setCookie = await sessionStorage.commitSession(session);
  // commitSession returns "__session=<value>; Path=/; ...". The Cookie
  // header only needs the name=value pair.
  const firstSegment = setCookie.split(";")[0];
  return firstSegment;
}
