import { postgresTest } from "@internal/testcontainers";
import { EnvironmentPauseSource, type PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { authIncludeBase, toAuthenticated } from "~/models/runtimeEnvironment.server";
import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function authEnv(
  prisma: PrismaClient,
  environmentId: string
): Promise<AuthenticatedEnvironment> {
  const row = await prisma.runtimeEnvironment.findFirstOrThrow({
    where: { id: environmentId },
    include: authIncludeBase,
  });
  return toAuthenticated(row);
}

async function seedProductionEnv(prisma: PrismaClient) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  return { organization, project, environment };
}

describe("PauseEnvironmentService", () => {
  postgresTest(
    "resumes a manually paused env (pauseSource stays null through pause and resume)",
    async ({ prisma }) => {
      const { environment } = await seedProductionEnv(prisma);
      const service = new PauseEnvironmentService(prisma);
      const env = await authEnv(prisma, environment.id);

      const paused = await service.call(env, "paused");
      expect(paused).toEqual({ success: true, state: "paused" });

      const afterPause = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
      });
      // Manual pause never sets pauseSource; leaving it null is what tripped the
      // pre-fix resume guard (Prisma NOT on a nullable field excludes NULL rows).
      expect(afterPause.paused).toBe(true);
      expect(afterPause.pauseSource).toBeNull();

      const resumed = await service.call(env, "resumed");
      expect(resumed).toEqual({ success: true, state: "resumed" });

      const afterResume = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
      });
      expect(afterResume.paused).toBe(false);
      expect(afterResume.pauseSource).toBeNull();
    }
  );

  postgresTest(
    "rejects resume of a billing-limit paused env and leaves it paused",
    async ({ prisma }) => {
      const { environment } = await seedProductionEnv(prisma);
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true, pauseSource: EnvironmentPauseSource.BILLING_LIMIT },
      });

      const service = new PauseEnvironmentService(prisma);
      const env = await authEnv(prisma, environment.id);

      const result = await service.call(env, "resumed");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("billing limit");

      const after = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
      });
      expect(after.paused).toBe(true);
      expect(after.pauseSource).toBe(EnvironmentPauseSource.BILLING_LIMIT);
    }
  );

  postgresTest(
    "manual pause while billing-limit paused is a no-op that preserves pauseSource",
    async ({ prisma }) => {
      const { environment } = await seedProductionEnv(prisma);
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true, pauseSource: EnvironmentPauseSource.BILLING_LIMIT },
      });

      const service = new PauseEnvironmentService(prisma);
      const env = await authEnv(prisma, environment.id);

      const result = await service.call(env, "paused");
      // Idempotent success without overwriting pauseSource, so billing-limit
      // converge can still find and unpause this env on resolve.
      expect(result).toEqual({ success: true, state: "paused" });

      const after = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
      });
      expect(after.paused).toBe(true);
      expect(after.pauseSource).toBe(EnvironmentPauseSource.BILLING_LIMIT);
    }
  );
});
