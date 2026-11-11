import { postgresTest } from "@internal/testcontainers";
import {
  $transaction,
  type PrismaClient,
  type WorkerDeploymentStatus,
} from "@trigger.dev/database";
import cuid from "cuid";
import { describe, expect } from "vitest";
import { deploymentBuildEnvVarsResponse } from "~/services/deploymentBuildEnvVars.server";
import { EnvironmentEncryptionService } from "~/services/environmentEncryption/service.server";
import { encryptValue, resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
const variables = { DATABASE_URL: "postgres://build", API_TOKEN: "secret" };

function encryptionService(db: PrismaClient, keys = keyring) {
  return new EnvironmentEncryptionService({
    db,
    transaction: (fn) => $transaction(db, fn),
    keyring: keys,
    writesEnabled: true,
    defaultWrappingPolicy: {
      wrappingProvider: "PLATFORM_KEYRING",
      wrappingKeyReference: keys.activeKeyId,
    },
  });
}

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
  const encryption = encryptionService(db);
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
  const read = (deploymentId: string) =>
    deploymentBuildEnvVarsResponse({ db, encryption, environment, deploymentId });
  return { project, organization, environment, encryption, createDeployment, read };
}

describe("deployment build env vars", () => {
  // Catches: the endpoint failing to read legacy envelopes after an environment's first key is initialized.
  postgresTest(
    "serves both legacy and environment-encrypted in-flight envelopes",
    async ({ prisma }) => {
      const { environment, encryption, createDeployment, read } = await setup(prisma);
      const legacy = await createDeployment();
      expect(await (await read(legacy.friendlyId)).json()).toEqual({ variables });
      const deployment = await createDeployment();
      const prepared = await encryption.prepareWrite({
        projectId: environment.projectId,
        environmentId: environment.id,
      });
      await prisma.workerDeployment.update({
        where: { id: deployment.id },
        data: {
          buildEnvVars: encryption.encrypt(
            prepared,
            { environmentId: environment.id, purpose: "build-env-vars", objectId: deployment.id },
            JSON.stringify(variables)
          ),
        },
      });
      const response = await read(deployment.friendlyId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ variables });
    }
  );

  // Catches: looking up a deployment by its friendly ID without restricting it to the authorized environment.
  postgresTest("does not return another environment's deployment", async ({ prisma }) => {
    const { project, organization, createDeployment, encryption } = await setup(prisma);
    const deployment = await createDeployment();
    const otherEnvironment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "STAGING",
    });
    const response = await deploymentBuildEnvVarsResponse({
      db: prisma,
      encryption,
      environment: otherEnvironment,
      deploymentId: deployment.friendlyId,
    });
    expect(response.status).toBe(404);
  });

  // Catches: serving retained build secrets after a deployment is final, rather than only to its in-flight redeploy copy.
  postgresTest("does not serve retained envelopes for final deployments", async ({ prisma }) => {
    const { createDeployment, read } = await setup(prisma);
    for (const status of ["DEPLOYED", "FAILED", "CANCELED", "TIMED_OUT"] as const) {
      const deployment = await createDeployment(status);
      const response = await read(deployment.friendlyId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ variables: {} });
    }
  });

  // Catches: copying valid encrypted build secrets between deployments without checking their bound object identity.
  postgresTest("rejects an envelope copied from a different deployment", async ({ prisma }) => {
    const { environment, encryption, createDeployment, read } = await setup(prisma);
    const source = await createDeployment();
    const destination = await createDeployment();
    const prepared = await encryption.prepareWrite({
      projectId: environment.projectId,
      environmentId: environment.id,
    });
    await prisma.workerDeployment.update({
      where: { id: destination.id },
      data: {
        buildEnvVars: encryption.encrypt(
          prepared,
          { environmentId: environment.id, purpose: "build-env-vars", objectId: source.id },
          JSON.stringify(variables)
        ),
      },
    });
    expect((await read(destination.friendlyId)).status).toBe(500);
  });

  // Catches: returning an empty successful response when the stored environment key cannot be unwrapped.
  postgresTest(
    "returns unavailable without dropping secrets when wrapping access is lost",
    async ({ prisma }) => {
      const { environment, encryption, createDeployment } = await setup(prisma);
      const deployment = await createDeployment();
      const prepared = await encryption.prepareWrite({
        projectId: environment.projectId,
        environmentId: environment.id,
      });
      await prisma.workerDeployment.update({
        where: { id: deployment.id },
        data: {
          buildEnvVars: encryption.encrypt(
            prepared,
            { environmentId: environment.id, purpose: "build-env-vars", objectId: deployment.id },
            JSON.stringify(variables)
          ),
        },
      });
      const unavailable = encryptionService(prisma, {
        activeKeyId: "replacement",
        keys: new Map([["replacement", "b".repeat(32)]]),
      });
      const response = await deploymentBuildEnvVarsResponse({
        db: prisma,
        encryption: unavailable,
        environment,
        deploymentId: deployment.friendlyId,
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Environment encryption key unavailable" });
    }
  );
});
