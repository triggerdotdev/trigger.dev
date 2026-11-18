import { containerTest } from "@internal/testcontainers";
import { expect, it, vi } from "vitest";
import { createTestOrgProjectWithMember } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
});

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
}));

vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
}));

import { buildFeedbackEvent } from "~/mcp/tools/feedback.server";

// Catches: passing the external ref through as the group, or resolving a project outside the user's orgs.
containerTest(
  "groups feedback by internal project id, only for member orgs",
  async ({ prisma }) => {
    mocks.db = prisma as unknown as Record<string | symbol, unknown>;
    const mine = await createTestOrgProjectWithMember(prisma);
    const other = await createTestOrgProjectWithMember(prisma);

    const own = await buildFeedbackEvent({
      userId: mine.user.id,
      message: "m",
      projectRef: mine.project.externalRef,
    });
    expect(own.projectId).toBe(mine.project.id);

    const foreign = await buildFeedbackEvent({
      userId: mine.user.id,
      message: "m",
      projectRef: other.project.externalRef,
    });
    expect(foreign.projectId).toBeUndefined();
  }
);

// Catches: a failed project lookup dropping the feedback instead of sending it ungrouped.
it("still returns the event when the project lookup throws", async () => {
  mocks.db = { project: { findFirst: () => Promise.reject(new Error("replica down")) } };

  const event = await buildFeedbackEvent({ userId: "u1", message: "m", projectRef: "proj_x" });

  expect(event).toMatchObject({ message: "m", projectId: undefined });
});
