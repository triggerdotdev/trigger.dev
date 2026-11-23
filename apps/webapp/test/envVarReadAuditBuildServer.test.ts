import { createStandalonePostgresContainer } from "@internal/testcontainers";
import {
  type ApiKeyIssuer,
  type PrismaClient,
  type WorkerDeploymentStatus,
} from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import cuid from "cuid";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Database from "~/db.server";
import type * as AuditLogsModule from "~/services/auditLogs/auditLogs.server";
import type * as AuthTelemetry from "~/services/authTelemetry.server";
import type * as EnvVarReadAudit from "~/services/auditLogs/envVarReadAudit.server";
import type * as DeploymentBuildEnvVars from "~/services/deploymentBuildEnvVars.server";
import type * as EnvironmentEncryption from "~/services/environmentEncryption/service.server";
import type * as HttpAsyncStorage from "~/services/httpAsyncStorage.server";
import { generateAdditionalApiKey } from "~/utils/apiKeys";
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
let authTelemetry: typeof AuthTelemetry;
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
  authTelemetry = await import("~/services/authTelemetry.server");
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
// for the deployment, and attributed to Trigger.dev infrastructure when the build's own deploy
// key read.

const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
const variables = { DATABASE_URL: "postgres://build-secret-host", API_TOKEN: "very-secret-token" };

async function setup(db: PrismaClient) {
  const { project, organization, user } = await createTestOrgProjectWithMember(db);
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
  /** An additional key on the environment: `SYSTEM` is the deploy key billing mints for a build. */
  const createAdditionalKey = async (issuedBy: ApiKeyIssuer) => {
    const token = generateAdditionalApiKey("PRODUCTION").apiKey;
    const row = await db.apiKey.create({
      data: {
        name: issuedBy === "SYSTEM" ? "Deploy key" : "Integration",
        keyHash: createHash("sha256").update(token).digest("hex"),
        lastFour: token.slice(-4),
        runtimeEnvironmentId: environment.id,
        createdByUserId: issuedBy === "SYSTEM" ? null : user.id,
        scopes: ["read:deployments", "write:deployments", "read:envvars"],
        issuedBy,
      },
    });
    return { id: row.id, token };
  };
  /** The build server's request with `token`, authenticated by the real bearer resolution. */
  const readWithKey = (deploymentId: string, token: string) =>
    httpAsyncStorage.runWithHttpContext(
      {
        requestId: "req_build",
        path: `/api/v1/deployments/${deploymentId}/build-env-vars`,
        host: "localhost",
        method: "GET",
        abortController: new AbortController(),
      },
      async () => {
        const result = await authTelemetry.authenticateBearerWithTelemetry(
          new Request(`https://api.trigger.dev/api/v1/deployments/${deploymentId}/build-env-vars`, {
            headers: { Authorization: `Bearer ${token}`, "x-forwarded-for": "10.0.0.5" },
          }),
          {},
          plugin.create({ primary: db, replica: db }, { forceFallback: true })
        );
        expect(result.ok).toBe(true);
        envVarReadAudit.noteDeploymentOrigin({ deploymentId });
        return deploymentBuildEnvVars.deploymentBuildEnvVarsResponse({
          db,
          encryption,
          environment,
          deploymentId,
        });
      }
    );
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
  return {
    organization,
    project,
    environment,
    user,
    createDeployment,
    createAdditionalKey,
    read,
    readWithKey,
  };
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
    expect(recorded[0]!.context.onBehalfOf).toBeNull();
    const serialized = JSON.stringify(recorded);
    for (const value of Object.values(variables)) expect(serialized).not.toContain(value);
  });

  // Catches: the build's own deploy key recorded as the customer's key, losing the deployment or
  // the key.
  it("records the build's deploy key as Trigger.dev infrastructure", async () => {
    const { createDeployment, createAdditionalKey, readWithKey } = await setup(database.prisma);
    const deployment = await createDeployment();
    const deployKey = await createAdditionalKey("SYSTEM");

    const response = await readWithKey(deployment.friendlyId, deployKey.token);
    expect(response.status).toBe(200);

    await auditLogs.flush();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.input).toMatchObject({ action: "envvar.listed" });
    expect(recorded[0]!.context).toMatchObject({
      actor: { type: "trigger_infra", id: null },
      origin: { deploymentId: deployment.friendlyId },
      credential: {
        kind: "additional_api_key",
        id: deployKey.id,
        last4: deployKey.token.slice(-4),
      },
      onBehalfOf: null,
    });
  });

  // Catches: a customer's own key treated as the build.
  it("keeps a user-issued key as the actor", async () => {
    const { createDeployment, createAdditionalKey, readWithKey } = await setup(database.prisma);
    const deployment = await createDeployment();
    const customerKey = await createAdditionalKey("USER");

    expect((await readWithKey(deployment.friendlyId, customerKey.token)).status).toBe(200);

    await auditLogs.flush();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.context).toMatchObject({
      actor: { type: "api_key", id: customerKey.id },
      origin: { deploymentId: deployment.friendlyId },
      onBehalfOf: null,
    });
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
