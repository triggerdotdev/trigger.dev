import { containerTest } from "@internal/testcontainers";
import { EnvironmentPauseSource, type PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

// The service's import chain reaches module-level singletons that throw at load
// time when REDIS_HOST/REDIS_PORT are unset (autoIncrementCounter via
// triggerTaskV1), so the env must point at the redis container BEFORE the
// module is imported. Hence dynamic imports; vitest runs each file in its own
// fork, so the env mutation cannot leak into other suites.
async function loadService(redisOptions: RedisOptions) {
  process.env.REDIS_HOST = redisOptions.host;
  process.env.REDIS_PORT = String(redisOptions.port);
  process.env.REDIS_TLS_DISABLED = "true";
  const [{ PauseEnvironmentService }, { authIncludeBase, toAuthenticated }] = await Promise.all([
    import("~/v3/services/pauseEnvironment.server"),
    import("~/models/runtimeEnvironment.server"),
  ]);
  return { PauseEnvironmentService, authIncludeBase, toAuthenticated };
}

type Loaded = Awaited<ReturnType<typeof loadService>>;

async function authEnv(
  loaded: Loaded,
  prisma: PrismaClient,
  environmentId: string
): Promise<AuthenticatedEnvironment> {
  const row = await prisma.runtimeEnvironment.findFirstOrThrow({
    where: { id: environmentId },
    include: loaded.authIncludeBase,
  });
  return loaded.toAuthenticated(row);
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
  containerTest(
    "resumes a manually paused env (pauseSource stays null through pause and resume)",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadService(redisOptions);
      const { environment } = await seedProductionEnv(prisma);
      const service = new loaded.PauseEnvironmentService(prisma);
      const env = await authEnv(loaded, prisma, environment.id);

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

  containerTest(
    "rejects resume of a billing-limit paused env and leaves it paused",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadService(redisOptions);
      const { environment } = await seedProductionEnv(prisma);
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true, pauseSource: EnvironmentPauseSource.BILLING_LIMIT },
      });

      const service = new loaded.PauseEnvironmentService(prisma);
      const env = await authEnv(loaded, prisma, environment.id);

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

  containerTest(
    "manual pause while billing-limit paused is a no-op that preserves pauseSource",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadService(redisOptions);
      const { environment } = await seedProductionEnv(prisma);
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true, pauseSource: EnvironmentPauseSource.BILLING_LIMIT },
      });

      const service = new loaded.PauseEnvironmentService(prisma);
      const env = await authEnv(loaded, prisma, environment.id);

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
