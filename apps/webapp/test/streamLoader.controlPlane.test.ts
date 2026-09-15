// Dedicated run-ops proof for the run-detail realtime stream loader after dropping its cross-DB
// control-plane include. The TaskRun scalar row lives on the dedicated run-ops client (PG17, subset
// schema, no control-plane tables); env lives on PG14. The DB is never mocked; the .count() proof
// shows the run does not exist on the control-plane side.
import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { resolveStreamBasin } from "~/services/realtime/v1StreamsGlobal.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let n = 0;
async function seedControlPlane(prisma: PrismaClient) {
  const s = n++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${s}`, slug: `org-${s}`, streamBasinName: `basin-${s}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `P ${s}`,
      slug: `p-${s}`,
      externalRef: `proj_${s}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `prod-${s}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${s}`,
      pkApiKey: `pk_${s}`,
      shortcode: `sc_${s}`,
    },
  });
  return { organization, project, environment };
}

// The run lives on the dedicated run-ops client; control-plane FKs are synthetic
// scalar ids pointing at PG14 rows (the dedicated DB has no control-plane tables).
async function seedRunOpsRun(
  prisma: RunOpsPrismaClient,
  ctx: { organizationId: string; projectId: string; environmentId: string }
) {
  const s = n++;
  return prisma.taskRun.create({
    data: {
      friendlyId: `run_2abc${s}defghijklmnopqrst`,
      taskIdentifier: "my-task",
      status: "PENDING",
      payload: "{}",
      payloadType: "application/json",
      traceId: `trace_${s}`,
      spanId: `span_${s}`,
      queue: "task/my-task",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "PRODUCTION",
      engine: "V2",
      realtimeStreamsVersion: "v1",
      streamBasinName: null,
    },
  });
}

describe("run-detail stream loader cross-DB read-through (dedicated run-ops client)", () => {
  heteroRunOpsPostgresTest(
    "run-ops scalars resolve from the dedicated run-ops DB; env (slug/org/basin) resolves from control-plane with no cross-join",
    async ({ prisma14, prisma17 }) => {
      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient);
      const run = await seedRunOpsRun(prisma17, {
        organizationId: cp.organization.id,
        projectId: cp.project.id,
        environmentId: cp.environment.id,
      });

      const found = await prisma17.taskRun.findFirst({
        where: { friendlyId: run.friendlyId, projectId: cp.project.id },
        select: {
          id: true,
          friendlyId: true,
          realtimeStreamsVersion: true,
          streamBasinName: true,
          runtimeEnvironmentId: true,
          projectId: true,
        },
      });
      expect(found).not.toBeNull();
      expect(found!.friendlyId).toBe(run.friendlyId);
      expect(found!.runtimeEnvironmentId).toBe(cp.environment.id);

      const resolver = new ControlPlaneResolver({
        controlPlanePrimary: prisma14 as unknown as PrismaClient,
        controlPlaneReplica: prisma14 as unknown as PrismaClient,
        cache: new ControlPlaneCache(),
        splitEnabled: () => false,
      });
      const environment = await resolver.resolveAuthenticatedEnv(found!.runtimeEnvironmentId);
      expect(environment).not.toBeNull();
      expect(environment!.slug).toBe(cp.environment.slug);
      expect(environment!.organization.id).toBe(cp.organization.id);
      expect(environment!.organization.streamBasinName).toBe(cp.organization.streamBasinName);

      const basin = resolveStreamBasin({
        run: { streamBasinName: found!.streamBasinName },
        organization: { streamBasinName: environment!.organization.streamBasinName },
      });
      expect(basin).toBe(cp.organization.streamBasinName);

      // Inversion proof: no run on PG14 (control-plane).
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});
