// Cross-cutting auth-layer behaviours that aren't tied to a specific route
// family — see TRI-8743. Soft-deleted projects, revoked keys, expired JWTs,
// cross-env mismatch, force-fallback toggle.

import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";

describe("Cross-cutting", () => {
  // Placeholder until TRI-8743 adds the actual matrix.
  it("shared prisma client can read from the postgres container", async () => {
    const server = getTestServer();
    const count = await server.prisma.user.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
