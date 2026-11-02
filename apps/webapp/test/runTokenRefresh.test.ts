import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { metrics } from "@opentelemetry/api";
import type { ExecutionResult } from "@trigger.dev/core/v3";
import { RUN_TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS } from "@trigger.dev/core/v3/workers";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { seedTestRun } from "./helpers/seedTestRun";
import { createInMemoryMetrics } from "./utils/tracing";

import type * as Database from "~/db.server";
import type * as RunTokenAuth from "~/services/oidc/runTokenAuth.server";
import type * as Refresh from "~/v3/services/worker/runTokenRefresh.server";

const ONE_HOUR_SECONDS = 60 * 60;

let database: typeof Database;
let refresh: typeof Refresh;
let runTokenAuth: typeof RunTokenAuth;
let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let telemetry: ReturnType<typeof createInMemoryMetrics>;

beforeAll(async () => {
  telemetry = createInMemoryMetrics();
  metrics.disable();
  metrics.setGlobalMeterProvider(telemetry.meterProvider);
  container = await createStandalonePostgresContainer();
  for (const key of [
    "DATABASE_URL",
    "DIRECT_URL",
    "CONTROL_PLANE_DATABASE_URL",
    "DATABASE_READ_REPLICA_URL",
    "CONTROL_PLANE_DATABASE_READ_REPLICA_URL",
  ]) {
    vi.stubEnv(key, container.url);
  }
  vi.stubEnv("MAGIC_LINK_SECRET", "run-token-refresh-test-magic-link");
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-for-e2e!!!!!");
  vi.stubEnv("DEPLOY_REGISTRY_HOST", "registry.example.com");
  vi.stubEnv("V4_DEPLOY_REGISTRY_HOST", "registry.example.com");
  vi.stubEnv("CLICKHOUSE_URL", "http://localhost:19123");
  vi.stubEnv("RUN_TOKEN_ISSUER_URL", "https://internal-token.example.com");

  database = await import("~/db.server");
  const { internalRunSigningService } = await import("~/services/oidc/instance.server");
  const staged = await internalRunSigningService.generateStagedKey("run-token-refresh-test");
  // Skip the key propagation wait.
  await database.prisma.oidcSigningKey.update({
    where: { id: staged.id },
    data: { readyAt: new Date(Date.now() - 1_000) },
  });
  await internalRunSigningService.activateKey(staged.id, "run-token-refresh-test");

  refresh = await import("~/v3/services/worker/runTokenRefresh.server");
  runTokenAuth = await import("~/services/oidc/runTokenAuth.server");
}, 120_000);

afterAll(async () => {
  await telemetry?.shutdown();
  metrics.disable();
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

async function seedExecutingRun({ injection = true } = {}) {
  const { environment, organization } = await seedTestEnvironment(database.prisma);
  await database.prisma.organization.update({
    where: { id: organization.id },
    data: { featureFlags: { runTokenInjection: injection } },
  });
  const { run, runFriendlyId } = await seedTestRun(database.prisma, {
    environmentId: environment.id,
    projectId: environment.projectId,
  });

  const heartbeat: ExecutionResult = {
    snapshot: {
      id: "snapshot_internal",
      friendlyId: "snapshot_1",
      executionStatus: "EXECUTING",
      description: "Executing",
      createdAt: new Date(),
    },
    run: { id: run.id, friendlyId: runFriendlyId, status: "EXECUTING", attemptNumber: 2 },
  };

  return { environment, run, runFriendlyId, heartbeat };
}

function request(
  seeded: Awaited<ReturnType<typeof seedExecutingRun>>,
  remainingSeconds: number,
  overrides: Partial<Refresh.RunTokenRefreshRequest> = {}
): Refresh.RunTokenRefreshRequest {
  return {
    report: {
      expiresAt: Math.floor(Date.now() / 1_000) + remainingSeconds,
      trigger: "heartbeat",
    },
    heartbeat: seeded.heartbeat,
    snapshotFriendlyId: "snapshot_1",
    environmentId: seeded.environment.id,
    findRun: (runId) =>
      database.prisma.taskRun.findFirst({
        where: { id: runId },
        select: { taskIdentifier: true, runtimeEnvironmentId: true, lockedById: true },
      }),
    replica: database.$replica,
    ...overrides,
  };
}

async function issuedCount(labels: Record<string, string>) {
  const exported = await telemetry.getMetrics();
  const latest = exported.at(-1);
  const metric = latest?.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((m) => m.descriptor.name === "run_token.refresh.issued");
  return (metric?.dataPoints ?? [])
    .filter((point) =>
      Object.entries(labels).every(([key, value]) => point.attributes[key] === value)
    )
    .reduce((sum, point) => sum + Number(point.value), 0);
}

describe("refreshRunTokenOnHeartbeat", () => {
  it("issues a one-hour replacement for the same attempt once the installed token is due", async () => {
    const seeded = await seedExecutingRun();
    const remaining = RUN_TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS - 60;

    const token = await refresh.refreshRunTokenOnHeartbeat(request(seeded, remaining));

    expect(token).toBeDefined();
    const claims = decodeJwt(token!);
    expect(claims).toMatchObject({
      run_id: seeded.runFriendlyId,
      attempt: 2,
      task_id: "test-task",
      environment_id: seeded.environment.id,
      org_id: seeded.environment.organizationId,
      project_id: seeded.environment.projectId,
    });
    expect(claims.exp! - claims.iat!).toBe(ONE_HOUR_SECONDS);

    const authenticated = await runTokenAuth.authenticateRunToken(token!);
    expect(authenticated.ok).toBe(true);
    expect(await issuedCount({ result: "success", reason: "none" })).toBeGreaterThan(0);
  });

  it("does not sign while the installed token has more than the refresh window left", async () => {
    const seeded = await seedExecutingRun();

    await expect(
      refresh.refreshRunTokenOnHeartbeat(
        request(seeded, RUN_TOKEN_REFRESH_BEFORE_EXPIRY_SECONDS + 60, {
          findRun: () => Promise.reject(new Error("must not read the run")),
        })
      )
    ).resolves.toBeUndefined();
  });

  it("refuses unscoped refreshes without reading or signing for the named run", async () => {
    const seeded = await seedExecutingRun();
    const before = await issuedCount({ result: "skipped", reason: "identity_mismatch" });

    await expect(
      refresh.refreshRunTokenOnHeartbeat(
        request(seeded, 0, {
          environmentId: undefined,
          findRun: () => Promise.reject(new Error("must not read an unscoped run")),
        })
      )
    ).resolves.toBeUndefined();
    expect(await issuedCount({ result: "skipped", reason: "identity_mismatch" })).toBe(before + 1);
  });

  it("refuses stale snapshots, other environments and orgs with injection turned off", async () => {
    const seeded = await seedExecutingRun();
    const disabled = await seedExecutingRun({ injection: false });

    for (const [req, reason] of [
      [request(seeded, 0, { snapshotFriendlyId: "snapshot_old" }), "stale_snapshot"],
      [request(seeded, 0, { environmentId: disabled.environment.id }), "identity_mismatch"],
      [request(disabled, 0), "injection_disabled"],
    ] as const) {
      const before = await issuedCount({ result: "skipped", reason });
      await expect(refresh.refreshRunTokenOnHeartbeat(req)).resolves.toBeUndefined();
      expect(await issuedCount({ result: "skipped", reason })).toBe(before + 1);
    }
  });
});
