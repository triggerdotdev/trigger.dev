import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { type PrismaClient, type WorkerDeploymentStatus } from "@trigger.dev/database";
import cuid from "cuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Database from "~/db.server";
import type * as AuditLogsModule from "~/services/auditLogs/auditLogs.server";
import type * as EnvVarReadAudit from "~/services/auditLogs/envVarReadAudit.server";
import type * as DeploymentBuildEnvVars from "~/services/deploymentBuildEnvVars.server";
import type * as EnvironmentEncryption from "~/services/environmentEncryption/service.server";
import type * as HttpAsyncStorage from "~/services/httpAsyncStorage.server";
import { encryptValue, resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";
import {
  enableAuditRecording,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

vi.mock("~/env.server", async (original) =>
  (await import("./helpers/auditLogPlugin")).auditRecordingEnv(await original())
);

vi.setConfig({ testTimeout: 30_000 });

// The app's own database client points at this container, so the recording flag the helper writes
// and the per-org lookup that reads it are in the same database as the test's rows.
let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let auditLogs: typeof AuditLogsModule.auditLogs;
let envVarReadAudit: typeof EnvVarReadAudit;
let deploymentBuildEnvVars: typeof DeploymentBuildEnvVars;
let environmentEncryption: typeof EnvironmentEncryption;
let httpAsyncStorage: typeof HttpAsyncStorage;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);

  database = await import("~/db.server");
  ({ auditLogs } = await import("~/services/auditLogs/auditLogs.server"));
  envVarReadAudit = await import("~/services/auditLogs/envVarReadAudit.server");
  deploymentBuildEnvVars = await import("~/services/deploymentBuildEnvVars.server");
  environmentEncryption = await import("~/services/environmentEncryption/service.server");
  httpAsyncStorage = await import("~/services/httpAsyncStorage.server");
}, 120_000);

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

// The build server's env var read, with a real database: recorded only when values are served,
// and attributed to Trigger.dev infrastructure for the deployment.

const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
const variables = { DATABASE_URL: "postgres://build-secret-host", API_TOKEN: "very-secret-token" };

async function setup(db: PrismaClient) {
  const { project, organization } = await createTestOrgProjectWithMember(db);
  await db.organization.update({
    where: { id: organization.id },
    data: { featureFlags: { [FEATURE_FLAG.environmentEncryptionEnabled]: true } },
  });
  const environment = await createRuntimeEnvironment(db, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });
  const encryption = new environmentEncryption.EnvironmentEncryptionService({
    db,
    transaction: (fn) => database.$transaction(db, fn),
    keyring,
    writesEnabled: true,
    defaultWrappingPolicy: {
      wrappingProvider: "PLATFORM_KEYRING",
      wrappingKeyReference: keyring.activeKeyId,
    },
  });
  const createDeployment = (status: WorkerDeploymentStatus = "BUILDING") =>
    db.workerDeployment.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        friendlyId: `deployment_${cuid()}`,
        shortCode: cuid(),
        version: cuid(),
        status,
        contentHash: "hash",
        buildEnvVars: encryptValue(JSON.stringify(variables), keyring),
      },
    });
  /** The build server's request: authenticated with the environment's key, then noted as infra. */
  const read = (deploymentId: string) =>
    httpAsyncStorage.runWithHttpContext(
      {
        requestId: "req_build",
        path: `/api/v1/deployments/${deploymentId}/build-env-vars`,
        host: "localhost",
        method: "GET",
        abortController: new AbortController(),
        auditIdentity: {
          actor: { type: "api_key", id: environment.id },
          credential: {
            kind: "root_api_key",
            id: environment.id,
            last4: "wxyz",
            fingerprintId: null,
          },
          onBehalfOf: null,
          source: "cli",
          endpoint: { ip: "10.0.0.5", userAgent: "trigger.dev-cli" },
          origin: null,
        },
      },
      async () => {
        envVarReadAudit.noteDeploymentOrigin({ deploymentId });
        return deploymentBuildEnvVars.deploymentBuildEnvVarsResponse({
          db,
          encryption,
          environment,
          deploymentId,
        });
      }
    );
  return { organization, project, environment, createDeployment, read };
}

let recorded: ReturnType<typeof installAuditLogPlugin>["recorded"];
let disableRecording: (() => Promise<void>) | undefined;

beforeEach(async () => {
  delete (globalThis as any).__trigger_singletons?.auditEnvVarReadRollup;
  recorded = installAuditLogPlugin().recorded;
  disableRecording = await enableAuditRecording();
});

afterEach(async () => {
  await disableRecording?.();
  disableRecording = undefined;
  uninstallAuditLogPlugin();
});

describe("build server env var reads", () => {
  // Catches: the build server's read not recorded, attributed to anyone but the key that made it,
  // deployment, or carrying the values it served.
  it("records envvar.listed by the key that read, for the deployment", async () => {
    const { organization, project, environment, createDeployment, read } = await setup(
      database.prisma
    );
    const deployment = await createDeployment();

    const response = await read(deployment.friendlyId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ variables });

    await auditLogs.flush();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.input).toMatchObject({
      category: "envvars",
      action: "envvar.listed",
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      environmentType: "PRODUCTION",
      target: { type: "environment", id: environment.id, name: environment.slug },
    });
    expect(recorded[0]!.context).toMatchObject({
      actor: { type: "api_key", id: environment.id },
      origin: { deploymentId: deployment.friendlyId },
      credential: { kind: "root_api_key", id: environment.id, last4: "wxyz" },
    });
    const serialized = JSON.stringify(recorded);
    for (const value of Object.values(variables)) expect(serialized).not.toContain(value);
  });

  // Catches: recording a read when no values were served (final deployment, unknown deployment).
  it("records nothing when no values are served", async () => {
    const { createDeployment, read } = await setup(database.prisma);
    const finalDeployment = await createDeployment("DEPLOYED");
    expect(await (await read(finalDeployment.friendlyId)).json()).toEqual({ variables: {} });
    expect((await read("deployment_missing")).status).toBe(404);

    await auditLogs.flush();
    expect(recorded).toEqual([]);
  });
});
