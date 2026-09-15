// ProjectAlert.taskRunId/taskRunAttemptId FKs point INTO the run subgraph. A run-ops run lives ONLY
// on the dedicated run-ops DB (prisma17), so `projectAlert.create({ taskRunId: <run-ops id> })` on
// control-plane (prisma14) violates the FK and the alert is silently dropped. After the FK drop +
// @relation removal the create succeeds; the read path resolves the run via runStore.findRun.
// Asserts the create succeeds: it fails with an FK violation before the fix and succeeds after.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";

// v1 internal id (26 chars, version "1" at index 25) → NEW (lives only on the dedicated run-ops DB).
const NEW_ID_26 = "k".repeat(24) + "01";

async function seedControlPlaneAlertPrereqs(prisma: PrismaClient, suffix: string) {
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
      slug: "prod",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `alert_channel_${suffix}`,
      type: "EMAIL",
      name: "Email",
      properties: { type: "EMAIL", email: "alerts@example.com" },
      alertTypes: ["TASK_RUN"],
      projectId: project.id,
    },
  });
  return { organization, project, environment, channel };
}

describe("ProjectAlert control-plane → run-subgraph FK reconciliation", () => {
  heteroRunOpsPostgresTest(
    "creating a TASK_RUN alert with a run-ops id taskRunId (run only on the run-ops DB) succeeds on control-plane",
    async ({ prisma14, prisma17 }) => {
      const suffix = "alert-runops";
      const { project, environment, channel } = await seedControlPlaneAlertPrereqs(
        prisma14,
        suffix
      );

      // The run exists ONLY on the dedicated run-ops DB (prisma17), never on control-plane.
      await (prisma17 as RunOpsPrismaClient).taskRun.create({
        data: {
          id: NEW_ID_26,
          friendlyId: `run_${suffix}`,
          engine: "V2",
          status: "COMPLETED_WITH_ERRORS",
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceId: `trace_${suffix}`,
          spanId: `span_${suffix}`,
          queue: "task/my-task",
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          organizationId: project.organizationId,
          environmentType: "PRODUCTION",
        },
      });

      // Control-plane has no TaskRun row for NEW_ID_26. With the FK present this throws P2003;
      // after the FK is dropped + the @relation removed it succeeds.
      const alert = await prisma14.projectAlert.create({
        data: {
          friendlyId: `alert_${suffix}`,
          channelId: channel.id,
          projectId: project.id,
          environmentId: environment.id,
          status: "PENDING",
          type: "TASK_RUN",
          taskRunId: NEW_ID_26,
        },
      });

      expect(alert.taskRunId).toBe(NEW_ID_26);

      // The scalar round-trips and can be re-read off the control-plane row (the read path resolves
      // the actual run via runStore.findRun against the run-ops DB).
      const reread = await prisma14.projectAlert.findUniqueOrThrow({ where: { id: alert.id } });
      expect(reread.taskRunId).toBe(NEW_ID_26);
    },
    120_000
  );

  heteroRunOpsPostgresTest(
    "creating a TASK_RUN_ATTEMPT alert with a run-ops id taskRunAttemptId (attempt only on the run-ops DB) succeeds on control-plane",
    async ({ prisma14 }) => {
      const suffix = "alert-run-ops id-attempt";
      const { project, environment, channel } = await seedControlPlaneAlertPrereqs(
        prisma14,
        suffix
      );

      // A run-ops id attempt id with no matching control-plane TaskRunAttempt row. With the FK present
      // this throws P2003; after the FK is dropped it succeeds.
      const attemptId = "a".repeat(24) + "01";
      const alert = await prisma14.projectAlert.create({
        data: {
          friendlyId: `alert_${suffix}`,
          channelId: channel.id,
          projectId: project.id,
          environmentId: environment.id,
          status: "PENDING",
          type: "TASK_RUN_ATTEMPT",
          taskRunAttemptId: attemptId,
        },
      });

      expect(alert.taskRunAttemptId).toBe(attemptId);
    },
    120_000
  );
});
