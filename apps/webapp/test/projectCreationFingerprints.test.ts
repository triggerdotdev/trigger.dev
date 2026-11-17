import { afterEach, describe, expect, vi } from "vitest";

// Points the global client at the fixture's database; nothing else is replaced.
const db = vi.hoisted(() => ({ client: null as any }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));

import { postgresTest } from "@internal/testcontainers";
import { createProject } from "~/models/project.server";
import { hashApiKey } from "~/utils/apiKeys";
import {
  createTestOrgProjectWithMember,
  createTestUser,
} from "./fixtures/environmentVariablesFixtures";
import { installAuditLogPlugin, uninstallAuditLogPlugin } from "./helpers/auditLogPlugin";

vi.setConfig({ testTimeout: 60_000 });

afterEach(uninstallAuditLogPlugin);

describe("project creation fingerprints", () => {
  // Catches: the root keys of a new project's environments being saved with no creator.
  postgresTest(
    "saves every new environment's root key with the user who created the project",
    async ({ prisma }) => {
      db.client = prisma;
      const { organization, user: creator } = await createTestOrgProjectWithMember(prisma);
      const otherMember = await createTestUser(prisma);
      await prisma.orgMember.create({
        data: { organizationId: organization.id, userId: otherMember.id, role: "MEMBER" },
      });
      const { saved } = installAuditLogPlugin();

      const project = await createProject({
        organizationSlug: organization.slug,
        name: "Fingerprinted",
        userId: creator.id,
        version: "v2",
      });

      const environments = await prisma.runtimeEnvironment.findMany({
        where: { projectId: project.id },
        select: { apiKey: true, type: true },
      });
      expect(environments.filter((environment) => environment.type === "DEVELOPMENT")).toHaveLength(
        2
      );
      expect(saved.map((fingerprint) => fingerprint.hash).sort()).toEqual(
        environments.map((environment) => hashApiKey(environment.apiKey)).sort()
      );
      for (const fingerprint of saved) {
        expect(fingerprint).toMatchObject({
          kind: "root_api_key",
          projectId: project.id,
          createdBy: { type: "user", id: creator.id },
        });
      }
    }
  );
});
