import { describe, expect, vi } from "vitest";
import { randomBytes } from "crypto";
import type { TaskRun } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { seedTestRun } from "./helpers/seedTestRun";

// The service runs against the testcontainer prisma passed to its constructor.
// These empty stubs just satisfy the module-level db.server imports so the
// module tree loads; the guard under test uses the injected `this._prisma`.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));

import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";

vi.setConfig({ testTimeout: 60_000 });

describe("ReplayTaskRunService environment scoping", () => {
  postgresTest(
    "refuses to replay a run into an environment in another tenant's project",
    async ({ prisma }) => {
      // Tenant A owns the run; the override targets tenant B's environment.
      // Distinct orgs => distinct projects.
      const tenantA = await seedTestEnvironment(prisma);
      const tenantB = await seedTestEnvironment(prisma);

      const { run } = await seedTestRun(prisma, {
        environmentId: tenantA.environment.id,
        projectId: tenantA.project.id,
      });

      const service = new ReplayTaskRunService(prisma);

      await expect(service.call(run, { environmentId: tenantB.environment.id })).rejects.toThrow(
        "Cannot replay a run into an environment outside its project"
      );

      // No run was created in tenant B's project.
      const runsInVictimProject = await prisma.taskRun.count({
        where: { projectId: tenantB.project.id },
      });
      expect(runsInVictimProject).toBe(0);
    }
  );

  postgresTest(
    "refuses to replay when the override environment id does not exist",
    async ({ prisma }) => {
      const tenantA = await seedTestEnvironment(prisma);
      const { run } = await seedTestRun(prisma, {
        environmentId: tenantA.environment.id,
        projectId: tenantA.project.id,
      });

      const service = new ReplayTaskRunService(prisma);

      await expect(service.call(run, { environmentId: "env_does_not_exist" })).rejects.toThrow(
        "Cannot replay a run into an environment outside its project"
      );
    }
  );

  postgresTest(
    "allows a same-project override even when the source run carries no projectId",
    async ({ prisma }) => {
      // The buffered-run fallback passes a synthetic TaskRun with a
      // runtimeEnvironmentId but no projectId. A same-project override must
      // still be allowed, since the source project comes from the run's
      // environment, not from the (absent) projectId.
      const tenant = await seedTestEnvironment(prisma);
      const suffix = randomBytes(4).toString("hex");
      const stagingEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "staging",
          type: "STAGING",
          apiKey: `tr_stg_${suffix}`,
          pkApiKey: `pk_stg_${suffix}`,
          shortcode: `stg${suffix.slice(0, 1)}`,
          projectId: tenant.project.id,
          organizationId: tenant.organization.id,
        },
      });

      // Mirror the synthetic dashboard replay run: source env present, no projectId.
      const syntheticRun = {
        id: "run_buffered_synthetic",
        friendlyId: "run_buffered_synthetic",
        runtimeEnvironmentId: tenant.environment.id,
      } as unknown as TaskRun;

      const service = new ReplayTaskRunService(prisma);

      // The guard must pass; execution then proceeds past it (into stubbed
      // db.server), so any resulting error must NOT be the rejection.
      const error = await service
        .call(syntheticRun, { environmentId: stagingEnvironment.id })
        .catch((e) => e as Error);
      expect(error?.message).not.toBe(
        "Cannot replay a run into an environment outside its project"
      );
    }
  );
});
