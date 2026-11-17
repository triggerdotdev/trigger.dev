import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  createTestUser,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({ db: undefined as unknown as Record<string | symbol, unknown> }));

vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
}));

import { resolveMcpSubject } from "~/mcp/gate/resolveSubject.server";

describe("resolveMcpSubject branches", () => {
  postgresTest("resolves dev and preview branches to child environments", async ({ prisma }) => {
    mocks.db = prisma as unknown as Record<string | symbol, unknown>;
    const { user, organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
    const scope = { projectId: project.id, organizationId: organization.id };
    const identity = { userId: user.id } as Parameters<typeof resolveMcpSubject>[1];

    const dev = await createRuntimeEnvironment(prisma, {
      ...scope,
      type: "DEVELOPMENT",
      slug: "dev",
      orgMemberId: orgMember.id,
    });
    const preview = await createRuntimeEnvironment(prisma, {
      ...scope,
      type: "PREVIEW",
      slug: "preview",
    });
    const child = (parent: { id: string }, type: "DEVELOPMENT" | "PREVIEW", branchName: string) =>
      prisma.runtimeEnvironment.create({
        data: {
          slug: `${branchName}-slug`,
          type,
          ...scope,
          parentEnvironmentId: parent.id,
          branchName,
          apiKey: `api-${branchName}`,
          pkApiKey: `pk-${branchName}`,
          shortcode: `sc-${branchName}`,
        },
      });
    const devChild = await child(dev, "DEVELOPMENT", "feat-x");
    const previewChild = await child(preview, "PREVIEW", "feat-y");
    const args = { projectRef: project.externalRef };

    const cases = [
      {
        name: "dev branch",
        args: { ...args, environment: "dev", branch: "feat-x" },
        id: devChild.id,
      },
      {
        name: "default dev branch",
        args: { ...args, environment: "dev", branch: "default" },
        id: dev.id,
      },
      {
        name: "default dev branch with refs/heads prefix",
        args: { ...args, environment: "dev", branch: "refs/heads/default" },
        id: dev.id,
      },
      {
        name: "unknown dev branch",
        args: { ...args, environment: "dev", branch: "nope" },
        id: null,
      },
      {
        name: "preview branch",
        args: { ...args, environment: "preview", branch: "feat-y" },
        id: previewChild.id,
      },
      { name: "prod branch", args: { ...args, environment: "prod", branch: "feat-x" }, id: null },
    ];
    for (const c of cases) {
      const subject = await resolveMcpSubject(c.args, identity);
      expect({ name: c.name, id: subject?.environmentId ?? null }).toEqual({
        name: c.name,
        id: c.id,
      });
    }

    const outsider = await createTestUser(prisma);
    expect(
      await resolveMcpSubject(cases[0]!.args, { userId: outsider.id } as typeof identity)
    ).toBeNull();
  });
});
