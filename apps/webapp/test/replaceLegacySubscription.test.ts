import { postgresAndRedisTest, postgresTest } from "@internal/testcontainers";
import type {
  Prisma,
  PrismaClient,
  ProjectAlertType,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { applyAlertsMigration } from "./helpers/alertTables";

vi.setConfig({ testTimeout: 120_000 });

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  $transaction: (db: PrismaClient, fn: (tx: unknown) => Promise<unknown>) => db.$transaction(fn),
}));

const { ReplaceLegacySubscriptionService } =
  await import("~/v3/services/alerts/replaceLegacySubscription.server");
const { createWorker, depsFor } = await import("~/v3/services/alerts/alertLifecycleTestWorker");
const { alertEvaluationJobId } =
  await import("~/v3/services/alerts/engine/evaluateAlertJob.server");
const { createAlertFromDraft } = await import("~/v3/services/alerts/createAlertFromDraft.server");
const { listAlerts } = await import("~/v3/services/alerts/storage/alertStore.server");

async function boot(prisma: PrismaClient): Promise<PrismaClient> {
  await applyAlertsMigration(prisma);
  return prisma;
}

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seed(
  prisma: PrismaClient,
  alertTypes: ProjectAlertType[],
  environmentTypes: RuntimeEnvironmentType[]
) {
  const slug = `replace_${suffix()}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const other = await prisma.user.create({
    data: { email: `other_${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const member = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "MEMBER" },
  });
  const otherMember = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: other.id, role: "MEMBER" },
  });
  const environment = (
    type: RuntimeEnvironmentType,
    envSlug: string,
    orgMemberId?: string,
    extra: Partial<Prisma.RuntimeEnvironmentUncheckedCreateInput> = {}
  ) =>
    prisma.runtimeEnvironment.create({
      data: {
        ...extra,
        slug: envSlug,
        type,
        projectId: project.id,
        organizationId: organization.id,
        orgMemberId,
        apiKey: `tr_${envSlug}_${slug}`,
        pkApiKey: `pk_${envSlug}_${slug}`,
        shortcode: `${envSlug.slice(0, 2)}${suffix()}`,
      },
    });
  const production = await environment("PRODUCTION", "prod");
  const staging = await environment("STAGING", "stg");
  const dev = await environment("DEVELOPMENT", "dev", member.id);
  await environment("DEVELOPMENT", "dev-other", otherMember.id);

  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `alert_channel_${slug}`,
      name: "Email to ops@example.com",
      type: "EMAIL",
      projectId: project.id,
      properties: { email: "ops@example.com" },
      alertTypes,
      environmentTypes,
    },
  });

  return { project, user, channel, production, staging, dev, environment };
}

describe("ReplaceLegacySubscriptionService", () => {
  postgresAndRedisTest(
    "creates a runs.failed alert per selected environment and drops TASK_RUN from the channel",
    async ({ prisma, redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const db = await boot(prisma);
      const seeded = await seed(
        prisma,
        ["TASK_RUN", "DEPLOYMENT_FAILURE"],
        ["PRODUCTION", "STAGING"]
      );
      const service = new ReplaceLegacySubscriptionService(prisma, db, undefined, deps);
      const params = {
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "TASK_RUN",
        userId: seeded.user.id,
        environmentIds: [seeded.production.id, seeded.staging.id],
      };

      const result = await service.call(params);

      expect(result.replaced).toBe(true);
      expect(result.alertIds).toHaveLength(2);
      for (const id of result.alertIds) {
        expect(await worker.getJob(alertEvaluationJobId(id))).toBeTruthy();
      }
      const alerts = await listAlerts(db, { projectId: seeded.project.id });
      expect(alerts.map((alert) => alert.environmentId).sort()).toEqual(
        [seeded.production.id, seeded.staging.id].sort()
      );
      for (const alert of alerts) {
        expect(alert.capabilityKey).toBe("runs.failed");
        expect(alert.name).toBe("Failed runs above 0 on all runs");
        expect(alert.notifiers).toEqual([{ type: "channel", channelId: seeded.channel.id }]);
        expect(alert.condition).toMatchObject({ kind: "threshold", operator: ">", value: 0 });
      }
      const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
        where: { id: seeded.channel.id },
      });
      expect(channel.alertTypes).toEqual(["DEPLOYMENT_FAILURE"]);

      expect(await service.call(params)).toEqual({ replaced: false, alertIds: [] });
      expect(await listAlerts(db, { projectId: seeded.project.id })).toHaveLength(2);
      await worker.stop();
    }
  );

  postgresAndRedisTest(
    "keeps a channel left with no alert types as the notifier",
    async ({ prisma, redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["PRODUCTION", "DEVELOPMENT"]);

      const result = await new ReplaceLegacySubscriptionService(prisma, db, undefined, deps).call({
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "TASK_RUN",
        userId: seeded.user.id,
        environmentIds: [seeded.production.id, seeded.dev.id],
      });

      const alerts = await listAlerts(db, { projectId: seeded.project.id });
      expect(result.alertIds).toHaveLength(2);
      expect(alerts.map((alert) => alert.environmentId).sort()).toEqual(
        [seeded.production.id, seeded.dev.id].sort()
      );
      const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
        where: { id: seeded.channel.id },
      });
      expect(channel.alertTypes).toEqual([]);
      await worker.stop();
    }
  );

  postgresTest("refuses an alert type without a replacement", async ({ prisma }) => {
    const db = await boot(prisma);
    const seeded = await seed(prisma, ["DEPLOYMENT_FAILURE"], ["PRODUCTION"]);

    await expect(
      new ReplaceLegacySubscriptionService(prisma, db).call({
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "DEPLOYMENT_FAILURE",
        userId: seeded.user.id,
        environmentIds: [seeded.production.id],
      })
    ).rejects.toThrow("can't be replaced");
    expect(await listAlerts(db, { projectId: seeded.project.id })).toHaveLength(0);
  });

  postgresTest(
    "refuses without environments to cover and keeps the subscription",
    async ({ prisma }) => {
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["PREVIEW"]);

      await expect(
        new ReplaceLegacySubscriptionService(prisma, db).call({
          projectId: seeded.project.id,
          channelId: seeded.channel.id,
          alertType: "TASK_RUN",
          userId: seeded.user.id,
          environmentIds: [seeded.production.id],
        })
      ).rejects.toThrow("No environments to create alerts in");
      const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
        where: { id: seeded.channel.id },
      });
      expect(channel.alertTypes).toEqual(["TASK_RUN"]);
    }
  );

  postgresAndRedisTest(
    "skips archived environments and the preview parent",
    async ({ prisma, redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["STAGING", "PREVIEW"]);
      await prisma.runtimeEnvironment.update({
        where: { id: seeded.staging.id },
        data: { archivedAt: new Date() },
      });
      const parent = await seeded.environment("PREVIEW", "preview", undefined, {
        isBranchableEnvironment: true,
      });
      const branch = await seeded.environment("PREVIEW", "preview-feat", undefined, {
        parentEnvironmentId: parent.id,
        branchName: "feat",
      });

      const service = new ReplaceLegacySubscriptionService(prisma, db, undefined, deps);
      for (const skipped of [seeded.staging.id, parent.id]) {
        await expect(
          service.call({
            projectId: seeded.project.id,
            channelId: seeded.channel.id,
            alertType: "TASK_RUN",
            userId: seeded.user.id,
            environmentIds: [skipped],
          })
        ).rejects.toThrow("Unknown environment");
      }
      await service.call({
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "TASK_RUN",
        userId: seeded.user.id,
        environmentIds: [branch.id],
      });

      const alerts = await listAlerts(db, { projectId: seeded.project.id });
      expect(alerts.map((alert) => alert.environmentId)).toEqual([branch.id]);
      await worker.stop();
    }
  );

  postgresTest("refuses a disabled channel", async ({ prisma }) => {
    const db = await boot(prisma);
    const seeded = await seed(prisma, ["TASK_RUN"], ["PRODUCTION"]);
    await prisma.projectAlertChannel.update({
      where: { id: seeded.channel.id },
      data: { enabled: false },
    });

    await expect(
      new ReplaceLegacySubscriptionService(prisma, db).call({
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "TASK_RUN",
        userId: seeded.user.id,
        environmentIds: [seeded.production.id],
      })
    ).rejects.toThrow("Enable the channel");
    expect(await listAlerts(db, { projectId: seeded.project.id })).toHaveLength(0);
  });

  postgresAndRedisTest(
    "rolls back when an alert can't be created",
    async ({ prisma, redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["PRODUCTION", "STAGING"]);
      let calls = 0;
      const createdIds: string[] = [];
      const failSecond: typeof createAlertFromDraft = async (database, params, lifecycleDeps) => {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        const alert = await createAlertFromDraft(database, params, lifecycleDeps);
        createdIds.push(alert.id);
        return alert;
      };

      await expect(
        new ReplaceLegacySubscriptionService(prisma, db, failSecond, deps).call({
          projectId: seeded.project.id,
          channelId: seeded.channel.id,
          alertType: "TASK_RUN",
          userId: seeded.user.id,
          environmentIds: [seeded.production.id, seeded.staging.id],
        })
      ).rejects.toThrow("boom");
      expect(calls).toBe(2);
      expect(createdIds).toHaveLength(1);
      expect(await worker.getJob(alertEvaluationJobId(createdIds[0]))).toBeNull();
      expect(await listAlerts(db, { projectId: seeded.project.id })).toHaveLength(0);
      const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
        where: { id: seeded.channel.id },
      });
      expect(channel.alertTypes).toEqual(["TASK_RUN"]);
      await worker.stop();
    }
  );

  postgresAndRedisTest(
    "creates alerts only in the selected environments",
    async ({ prisma, redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["PRODUCTION", "STAGING", "DEVELOPMENT"]);

      const result = await new ReplaceLegacySubscriptionService(prisma, db, undefined, deps).call({
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "TASK_RUN",
        userId: seeded.user.id,
        environmentIds: [seeded.production.id],
      });

      expect(result).toMatchObject({ replaced: true, skipped: 0 });
      const alerts = await listAlerts(db, { projectId: seeded.project.id });
      expect(alerts.map((alert) => [alert.environmentId, alert.name])).toEqual([
        [seeded.production.id, "Failed runs above 0 on all runs"],
      ]);
      await worker.stop();
    }
  );

  postgresTest(
    "rejects a notifier channel unavailable in one selected environment and creates nothing",
    async ({ prisma }) => {
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["PRODUCTION", "STAGING"]);
      const prodOnly = await prisma.projectAlertChannel.create({
        data: {
          friendlyId: `alert_channel_prod_only_${suffix()}`,
          name: "Prod only",
          type: "EMAIL",
          projectId: seeded.project.id,
          properties: { email: "prod@example.com" },
          alertTypes: [],
          environmentTypes: ["PRODUCTION"],
        },
      });

      await expect(
        new ReplaceLegacySubscriptionService(prisma, db).call({
          projectId: seeded.project.id,
          channelId: seeded.channel.id,
          alertType: "TASK_RUN",
          userId: seeded.user.id,
          environmentIds: [seeded.production.id, seeded.staging.id],
          notifiers: [{ type: "channel", channelId: prodOnly.id }],
        })
      ).rejects.toThrow("isn't available in stg");
      expect(await listAlerts(db, { projectId: seeded.project.id })).toHaveLength(0);
      const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
        where: { id: seeded.channel.id },
      });
      expect(channel.alertTypes).toEqual(["TASK_RUN"]);
    }
  );

  postgresAndRedisTest(
    "names a task-scoped replacement after its task",
    async ({ prisma, redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["PRODUCTION"]);
      const backgroundWorker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: `worker_${suffix()}`,
          contentHash: `hash_${suffix()}`,
          version: "20260101.1",
          metadata: {},
          projectId: seeded.project.id,
          runtimeEnvironmentId: seeded.production.id,
        },
      });
      await prisma.backgroundWorkerTask.create({
        data: {
          friendlyId: `task_${suffix()}`,
          slug: "send-email",
          filePath: "src/trigger/send-email.ts",
          workerId: backgroundWorker.id,
          projectId: seeded.project.id,
          runtimeEnvironmentId: seeded.production.id,
        },
      });

      await new ReplaceLegacySubscriptionService(prisma, db, undefined, deps).call({
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "TASK_RUN",
        userId: seeded.user.id,
        environmentIds: [seeded.production.id],
        scope: { type: "task", taskIdentifier: "send-email" },
      });

      const alerts = await listAlerts(db, { projectId: seeded.project.id });
      expect(alerts.map((alert) => alert.name)).toEqual(["Failed runs above 0 on send-email"]);
      await worker.stop();
    }
  );

  postgresTest(
    "rejects an environment from another project and keeps the subscription",
    async ({ prisma }) => {
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["PRODUCTION"]);
      const foreign = await seed(prisma, ["TASK_RUN"], ["PRODUCTION"]);

      await expect(
        new ReplaceLegacySubscriptionService(prisma, db).call({
          projectId: seeded.project.id,
          channelId: seeded.channel.id,
          alertType: "TASK_RUN",
          userId: seeded.user.id,
          environmentIds: [seeded.production.id, foreign.production.id],
        })
      ).rejects.toThrow("Unknown environment");
      expect(await listAlerts(db, { projectId: seeded.project.id })).toHaveLength(0);
      const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
        where: { id: seeded.channel.id },
      });
      expect(channel.alertTypes).toEqual(["TASK_RUN"]);
    }
  );

  postgresAndRedisTest(
    "removes TASK_RUN from the channel only after every alert is created",
    async ({ prisma, redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["PRODUCTION", "STAGING"]);
      const typesAtCreate: ProjectAlertType[][] = [];
      const recording: typeof createAlertFromDraft = async (database, params, lifecycleDeps) => {
        const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
          where: { id: seeded.channel.id },
        });
        typesAtCreate.push(channel.alertTypes);
        return createAlertFromDraft(database, params, lifecycleDeps);
      };

      await new ReplaceLegacySubscriptionService(prisma, db, recording, deps).call({
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "TASK_RUN",
        userId: seeded.user.id,
        environmentIds: [seeded.production.id, seeded.staging.id],
      });

      expect(typesAtCreate).toEqual([["TASK_RUN"], ["TASK_RUN"]]);
      const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
        where: { id: seeded.channel.id },
      });
      expect(channel.alertTypes).toEqual([]);
      await worker.stop();
    }
  );

  postgresAndRedisTest(
    "rolls back when the channel gains coverage after authorization",
    async ({ prisma, redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const db = await boot(prisma);
      const seeded = await seed(prisma, ["TASK_RUN"], ["STAGING"]);
      const authorized: RuntimeEnvironmentType[][] = [];
      const widening: typeof createAlertFromDraft = async (database, params, lifecycleDeps) => {
        await prisma.projectAlertChannel.update({
          where: { id: seeded.channel.id },
          data: { environmentTypes: ["STAGING", "PRODUCTION"] },
        });
        return createAlertFromDraft(database, params, lifecycleDeps);
      };

      const result = await new ReplaceLegacySubscriptionService(prisma, db, widening, deps).call({
        projectId: seeded.project.id,
        channelId: seeded.channel.id,
        alertType: "TASK_RUN",
        userId: seeded.user.id,
        environmentIds: [seeded.staging.id],
        authorize: (environmentTypes) => {
          authorized.push(environmentTypes);
          if (environmentTypes.includes("PRODUCTION")) throw new Error("denied");
        },
      });

      expect(authorized).toEqual([["STAGING"]]);
      expect(result).toEqual({ replaced: false, alertIds: [] });
      expect(await listAlerts(db, { projectId: seeded.project.id })).toHaveLength(0);
      const channel = await prisma.projectAlertChannel.findUniqueOrThrow({
        where: { id: seeded.channel.id },
      });
      expect(channel.alertTypes).toEqual(["TASK_RUN"]);
      await worker.stop();
    }
  );
});
