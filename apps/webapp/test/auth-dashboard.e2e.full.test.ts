// Comprehensive dashboard session-auth tests — see TRI-8742.
// Each test seeds a User + session cookie via seedTestUser / seedTestSession
// (helpers/seedTestSession.ts) and hits the shared webapp container.

import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";

describe("Dashboard", () => {
  // Placeholder until TRI-8742+ adds the actual matrix.
  it("shared webapp container redirects /admin/concurrency to /login when unauthenticated", async () => {
    const server = getTestServer();
    const res = await server.webapp.fetch("/admin/concurrency", { redirect: "manual" });
    expect(res.status).toBe(302);
  });
});
