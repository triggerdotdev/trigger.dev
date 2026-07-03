// A standalone wait token is minted with a cuid id and, having no owning run, is written to the
// control-plane store. Under the split topology the run-ops read replica is a distinct database
// that does not hold it, so the public token routes must fan out to the control-plane replica or
// the token is reported missing. These reads run as real queries against two containers.
import { heteroPostgresTest } from "@internal/testcontainers";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";
import type { PrismaReplicaClient } from "~/db.server";
import { resolveWaitpointThroughReadThrough } from "~/runEngine/concerns/resolveWaitpointThroughReadThrough.server";
import { readThroughRun } from "./readThrough.server";

vi.setConfig({ testTimeout: 60_000 });

async function seedControlPlaneEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { organization, project, environment };
}

async function seedStandaloneToken(prisma: PrismaClient, environmentId: string, projectId: string) {
  const { id, friendlyId } = WaitpointId.generate();
  await prisma.waitpoint.create({
    data: {
      id,
      friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: id,
      userProvidedIdempotencyKey: false,
      environmentId,
      projectId,
    },
  });
  return { id, friendlyId };
}

describe("public wait-token resolution across the split boundary", () => {
  heteroPostgresTest(
    "a control-plane-resident standalone token is found when the run-ops replica does not hold it",
    async ({ prisma14, prisma17 }) => {
      const { project, environment } = await seedControlPlaneEnv(prisma14, "token_cp");
      const { id: waitpointId } = await seedStandaloneToken(prisma14, environment.id, project.id);

      const waitpoint = await resolveWaitpointThroughReadThrough({
        waitpointId,
        environmentId: environment.id,
        read: (client: PrismaReplicaClient) =>
          client.waitpoint.findFirst({
            where: { id: waitpointId, environmentId: environment.id },
          }),
        deps: {
          // Pin split-on explicitly: without it the fan-out gate falls back to the
          // ambient RUN_OPS_SPLIT_ENABLED env, which is unset in CI (single-DB
          // passthrough reads only the run-ops replica and never fans out to the
          // control-plane legacy replica that holds this cuid-shaped token).
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(waitpoint).not.toBeNull();
      expect(waitpoint?.id).toBe(waitpointId);
    }
  );

  heteroPostgresTest(
    "pinning both reads at the run-ops replica misses the control-plane token",
    async ({ prisma14, prisma17 }) => {
      const { project, environment } = await seedControlPlaneEnv(prisma14, "token_miss");
      const { id: waitpointId } = await seedStandaloneToken(prisma14, environment.id, project.id);

      const waitpoint = await resolveWaitpointThroughReadThrough({
        waitpointId,
        environmentId: environment.id,
        read: (client: PrismaReplicaClient) =>
          client.waitpoint.findFirst({
            where: { id: waitpointId, environmentId: environment.id },
          }),
        deps: {
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma17 as unknown as PrismaReplicaClient,
        },
      });

      expect(waitpoint).toBeNull();
    }
  );

  heteroPostgresTest(
    "the read gate forces fan-out so a control-plane token resolves while the mint flag is off",
    async ({ prisma14, prisma17 }) => {
      const { project, environment } = await seedControlPlaneEnv(prisma14, "token_gate");
      const { id: waitpointId } = await seedStandaloneToken(prisma14, environment.id, project.id);

      const read = (client: PrismaReplicaClient) =>
        client.waitpoint.findFirst({
          where: { id: waitpointId, environmentId: environment.id },
        });

      const gated = await resolveWaitpointThroughReadThrough({
        waitpointId,
        environmentId: environment.id,
        read,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(gated).not.toBeNull();
      expect(gated?.id).toBe(waitpointId);

      const passthrough = await readThroughRun({
        runId: waitpointId,
        environmentId: environment.id,
        readNew: (c) => read(c),
        readLegacy: (r) => read(r),
        deps: {
          splitEnabled: false,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(gated).not.toBeNull();
      expect(passthrough.source).toBe("not-found");
    }
  );
});
