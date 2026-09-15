import { RunEngine } from "@internal/run-engine";
import { trace } from "@opentelemetry/api";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "../fixtures/environmentVariablesFixtures";

export type EnvConcurrencyLimitPauseTestEngine = RunEngine;

export function createEnvConcurrencyLimitPauseTestEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions
) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, disabled: true },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      ttlSystem: { disabled: true },
    },
    batchQueue: { redis: redisOptions, consumerEnabled: false },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

// The import chain reaches module-level singletons that throw at load time when
// REDIS_HOST/REDIS_PORT are unset (autoIncrementCounter via triggerTaskV1), so the env must point
// at the redis container BEFORE the modules are imported. Vitest runs each file in its own fork,
// so the env mutation cannot leak into other suites.
export async function loadEnvConcurrencyLimitPauseServices(redisOptions: RedisOptions) {
  process.env.REDIS_HOST = redisOptions.host;
  process.env.REDIS_PORT = String(redisOptions.port);
  process.env.REDIS_TLS_DISABLED = "true";
  const [{ updateEnvConcurrencyLimits }, { PauseEnvironmentService }, runtimeEnvironment] =
    await Promise.all([
      import("~/v3/runQueue.server"),
      import("~/v3/services/pauseEnvironment.server"),
      import("~/models/runtimeEnvironment.server"),
    ]);

  return {
    updateEnvConcurrencyLimits,
    PauseEnvironmentService,
    authIncludeBase: runtimeEnvironment.authIncludeBase,
    toAuthenticated: runtimeEnvironment.toAuthenticated,
  };
}

export type EnvConcurrencyLimitPauseServices = Awaited<
  ReturnType<typeof loadEnvConcurrencyLimitPauseServices>
>;

export async function authEnv(
  loaded: EnvConcurrencyLimitPauseServices,
  prisma: PrismaClient,
  environmentId: string
): Promise<AuthenticatedEnvironment> {
  const row = await prisma.runtimeEnvironment.findFirstOrThrow({
    where: { id: environmentId },
    include: loaded.authIncludeBase,
  });

  return loaded.toAuthenticated(row);
}

export async function seedProductionEnv(prisma: PrismaClient, maximumConcurrencyLimit: number) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });

  await prisma.runtimeEnvironment.update({
    where: { id: environment.id },
    data: { maximumConcurrencyLimit },
  });

  return { organization, project, environment };
}
