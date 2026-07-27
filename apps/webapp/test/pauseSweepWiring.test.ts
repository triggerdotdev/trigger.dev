import { type PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const calls: string[] = [];

vi.mock("~/v3/runQueue.server", () => ({
  updateEnvConcurrencyLimits: vi.fn(async (_env: unknown, limit?: number) => {
    calls.push(`updateEnvConcurrencyLimits:${limit}`);
  }),
  updateQueueConcurrencyLimits: vi.fn(async (_env: unknown, name: string, limit: number) => {
    calls.push(`updateQueueConcurrencyLimits:${name}:${limit}`);
  }),
  removeQueueConcurrencyLimits: vi.fn(async () => {
    calls.push("removeQueueConcurrencyLimits");
  }),
  returnUnclaimedMessagesToQueue: vi.fn(async () => ({
    returned: 0,
    skipped: 0,
    errors: 0,
    passes: 1,
  })),
  sweepUnclaimedRuns: vi.fn(async (_env: unknown, queue?: string) => {
    calls.push(`sweepUnclaimedRuns:${queue ?? "*"}`);
  }),
}));

async function loadServices() {
  const [{ PauseEnvironmentService }, { authIncludeBase, toAuthenticated }] = await Promise.all([
    import("~/v3/services/pauseEnvironment.server"),
    import("~/models/runtimeEnvironment.server"),
  ]);
  return { PauseEnvironmentService, authIncludeBase, toAuthenticated };
}

type Loaded = Awaited<ReturnType<typeof loadServices>>;

async function seedEnv(
  loaded: Loaded,
  prisma: PrismaClient
): Promise<{ environment: AuthenticatedEnvironment; environmentId: string }> {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const created = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });

  const row = await prisma.runtimeEnvironment.findFirstOrThrow({
    where: { id: created.id },
    include: loaded.authIncludeBase,
  });

  return { environment: loaded.toAuthenticated(row), environmentId: created.id };
}

describe("pause sweep wiring", () => {
  postgresTest("pausing an environment sweeps after the limit is zeroed", async ({ prisma }) => {
    calls.length = 0;
    const loaded = await loadServices();
    const { environment } = await seedEnv(loaded, prisma);

    const result = await new loaded.PauseEnvironmentService(prisma).call(environment, "paused");

    expect(result).toEqual({ success: true, state: "paused" });
    expect(calls).toEqual(["updateEnvConcurrencyLimits:0", "sweepUnclaimedRuns:*"]);
  });

  postgresTest("resuming an environment does not sweep", async ({ prisma }) => {
    const loaded = await loadServices();
    const { environment, environmentId } = await seedEnv(loaded, prisma);

    await prisma.runtimeEnvironment.update({
      where: { id: environmentId },
      data: { paused: true },
    });

    calls.length = 0;

    const result = await new loaded.PauseEnvironmentService(prisma).call(environment, "resumed");

    expect(result).toEqual({ success: true, state: "resumed" });
    expect(calls).toEqual(["updateEnvConcurrencyLimits:undefined"]);
  });
});
