import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

type Resource = { type: string; envType?: string };
type Grant = { action: string; type: string; envType?: string };

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  userId: undefined as string | undefined,
  grants: [] as Grant[],
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", () => ({ env: { ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" } }));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: vi.fn() } }));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticatePat: async () => ({
      ok: true,
      userId: ctx.userId,
      tokenId: "pat_test",
      lastAccessedAt: new Date(),
      ability: {
        can: (action: string, resource: Resource | Resource[]) =>
          [resource]
            .flat()
            .some((r) =>
              ctx.grants.some(
                (g) =>
                  g.action === action &&
                  g.type === r.type &&
                  (g.envType === undefined || g.envType === r.envType)
              )
            ),
        canSuper: () => false,
      },
    }),
  },
}));

const { action } = await import("~/routes/api.v1.projects.$projectRef.alertChannels");
const { CreateAlertChannelService } =
  await import("~/v3/services/alerts/createAlertChannel.server");

function beforeServiceWrite(change: () => Promise<unknown>) {
  const original = CreateAlertChannelService.prototype.call;
  vi.spyOn(CreateAlertChannelService.prototype, "call").mockImplementationOnce(async function (
    this: InstanceType<typeof CreateAlertChannelService>,
    ...args
  ) {
    await change();
    return original.apply(this, args);
  });
}

async function seed(prisma: PrismaClient) {
  ctx.prisma = prisma;
  const slug = `ac${Math.random().toString(36).slice(2, 10)}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: { title: slug, slug, members: { create: { userId: user.id, role: "ADMIN" } } },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  ctx.userId = user.id;
  return { projectId: project.id, projectRef: project.externalRef };
}

async function post(projectRef: string, body: Record<string, unknown>) {
  const response = await action({
    request: new Request(`https://api.trigger.dev/api/v1/projects/${projectRef}/alertChannels`, {
      method: "POST",
      headers: { Authorization: "Bearer tr_pat_test", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: { projectRef },
    context: {},
  });
  return { status: response.status, body: await response.json() };
}

const emailChannel = {
  name: "ops",
  channel: "email",
  alertTypes: ["run_failure"],
  channelData: { email: "ops@example.com" },
};

describe("POST /api/v1/projects/:projectRef/alertChannels", () => {
  postgresTest("requires write:alerts in every requested environment", async ({ prisma }) => {
    const { projectId, projectRef } = await seed(prisma);
    ctx.grants = [{ action: "write", type: "alerts", envType: "PRODUCTION" }];

    const denied = await post(projectRef, {
      ...emailChannel,
      environmentTypes: ["STAGING", "PRODUCTION"],
    });
    expect(denied.status).toBe(403);
    expect(await prisma.projectAlertChannel.count({ where: { projectId } })).toBe(0);

    const allowed = await post(projectRef, { ...emailChannel, environmentTypes: ["PRODUCTION"] });
    expect(allowed.status).toBe(200);
    expect(await prisma.projectAlertChannel.count({ where: { projectId } })).toBe(1);
  });

  postgresTest("treats an unscoped channel as staging and production", async ({ prisma }) => {
    const { projectId, projectRef } = await seed(prisma);
    ctx.grants = [{ action: "write", type: "alerts", envType: "PRODUCTION" }];

    const denied = await post(projectRef, { ...emailChannel, environmentTypes: [] });
    expect(denied.status).toBe(403);
    expect(await prisma.projectAlertChannel.count({ where: { projectId } })).toBe(0);

    ctx.grants = ["PRODUCTION", "STAGING"].map((envType) => ({
      action: "write",
      type: "alerts",
      envType,
    }));
    const allowed = await post(projectRef, { ...emailChannel, environmentTypes: [] });
    expect(allowed.status).toBe(200);
    expect(await prisma.projectAlertChannel.count({ where: { projectId } })).toBe(1);
  });

  postgresTest("does not reuse a disabled identical channel", async ({ prisma }) => {
    const { projectId, projectRef } = await seed(prisma);
    ctx.grants = [{ action: "write", type: "alerts" }];

    const first = await post(projectRef, emailChannel);
    await prisma.projectAlertChannel.updateMany({ where: { projectId }, data: { enabled: false } });

    const second = await post(projectRef, emailChannel);
    expect(second.status).toBe(200);
    expect(second.body.id).not.toBe(first.body.id);
    expect(await prisma.projectAlertChannel.count({ where: { projectId } })).toBe(2);
  });

  postgresTest(
    "requires write on the environments of a keyed channel it updates",
    async ({ prisma }) => {
      const { projectId, projectRef } = await seed(prisma);
      ctx.grants = [{ action: "write", type: "alerts" }];
      const keyed = { ...emailChannel, deduplicationKey: "k1" };
      await post(projectRef, { ...keyed, environmentTypes: ["PRODUCTION"] });

      ctx.grants = [{ action: "write", type: "alerts", envType: "STAGING" }];
      const denied = await post(projectRef, {
        ...keyed,
        name: "renamed",
        environmentTypes: ["STAGING"],
      });
      expect(denied.status).toBe(403);
      const row = await prisma.projectAlertChannel.findFirstOrThrow({ where: { projectId } });
      expect(row.name).toBe("ops");
      expect(row.environmentTypes).toEqual(["PRODUCTION"]);
    }
  );

  postgresTest(
    "refuses a keyed update when the channel widened after the check",
    async ({ prisma }) => {
      const { projectId, projectRef } = await seed(prisma);
      ctx.grants = [{ action: "write", type: "alerts" }];
      const keyed = { ...emailChannel, deduplicationKey: "k1" };
      await post(projectRef, { ...keyed, environmentTypes: ["STAGING"] });

      ctx.grants = [{ action: "write", type: "alerts", envType: "STAGING" }];
      beforeServiceWrite(() =>
        prisma.projectAlertChannel.updateMany({
          where: { projectId },
          data: { environmentTypes: ["STAGING", "PRODUCTION"] },
        })
      );
      const raced = await post(projectRef, {
        ...keyed,
        name: "renamed",
        environmentTypes: ["STAGING"],
      });
      expect(raced.status).toBe(409);
      const row = await prisma.projectAlertChannel.findFirstOrThrow({ where: { projectId } });
      expect(row.name).toBe("ops");
      expect(row.environmentTypes).toEqual(["STAGING", "PRODUCTION"]);
    }
  );

  postgresTest(
    "refuses a keyed update when the channel is deleted after the write",
    async ({ prisma }) => {
      const { projectId, projectRef } = await seed(prisma);
      ctx.grants = [{ action: "write", type: "alerts" }];
      const keyed = { ...emailChannel, deduplicationKey: "k1" };
      await post(projectRef, keyed);

      const channels = prisma.projectAlertChannel;
      ctx.prisma = new Proxy(prisma, {
        get: (target, prop) =>
          prop === "projectAlertChannel"
            ? new Proxy(channels, {
                get: (model, method) =>
                  method === "updateMany"
                    ? async (args: any) => {
                        const result = await channels.updateMany(args);
                        await channels.deleteMany({ where: { projectId } });
                        return result;
                      }
                    : (model as any)[method],
              })
            : (target as any)[prop],
      });

      const raced = await post(projectRef, { ...keyed, name: "renamed" });
      expect(raced.status).toBe(409);
    }
  );

  postgresTest(
    "refuses a keyed update when the channel appeared after the check",
    async ({ prisma }) => {
      const { projectId, projectRef } = await seed(prisma);
      ctx.grants = [{ action: "write", type: "alerts", envType: "STAGING" }];
      beforeServiceWrite(() =>
        prisma.projectAlertChannel.create({
          data: {
            friendlyId: "alert_channel_raced",
            name: "ops",
            projectId,
            type: "EMAIL",
            properties: { email: "ops@example.com" },
            alertTypes: ["TASK_RUN"],
            environmentTypes: ["PRODUCTION"],
            deduplicationKey: "k1",
            userProvidedDeduplicationKey: true,
          },
        })
      );
      const raced = await post(projectRef, {
        ...emailChannel,
        name: "renamed",
        deduplicationKey: "k1",
        environmentTypes: ["STAGING"],
      });
      expect(raced.status).toBe(409);
      const row = await prisma.projectAlertChannel.findFirstOrThrow({ where: { projectId } });
      expect(row.name).toBe("ops");
      expect(row.environmentTypes).toEqual(["PRODUCTION"]);
    }
  );

  postgresTest("does not reuse a legacy webhook channel", async ({ prisma }) => {
    const { projectId, projectRef } = await seed(prisma);
    ctx.grants = [{ action: "write", type: "alerts" }];
    const webhook = {
      name: "hook",
      channel: "webhook",
      alertTypes: ["run_failure"],
      channelData: { url: "https://93.184.215.14/hook" },
    };

    const legacy = await post(projectRef, webhook);
    const row = await prisma.projectAlertChannel.findFirstOrThrow({ where: { projectId } });
    const { version: _version, ...properties } = row.properties as Record<string, unknown>;
    await prisma.projectAlertChannel.update({
      where: { id: row.id },
      data: { properties: properties as any },
    });

    const fresh = await post(projectRef, webhook);
    expect(fresh.status).toBe(200);
    expect(fresh.body.id).not.toBe(legacy.body.id);
    expect(await prisma.projectAlertChannel.count({ where: { projectId } })).toBe(2);
  });

  postgresTest("returns the existing channel for an identical request", async ({ prisma }) => {
    const { projectId, projectRef } = await seed(prisma);
    ctx.grants = [{ action: "write", type: "alerts" }];

    const first = await post(projectRef, emailChannel);
    const second = await post(projectRef, emailChannel);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(await prisma.projectAlertChannel.count({ where: { projectId } })).toBe(1);

    const webhook = {
      name: "hook",
      channel: "webhook",
      alertTypes: ["run_failure"],
      channelData: { url: "https://93.184.215.14/hook", secret: "s1" },
    };
    const hookA = await post(projectRef, webhook);
    const hookB = await post(projectRef, webhook);
    const hookC = await post(projectRef, {
      ...webhook,
      channelData: { ...webhook.channelData, secret: "s2" },
    });
    expect(hookB.body.id).toBe(hookA.body.id);
    expect(hookC.body.id).not.toBe(hookA.body.id);
    expect(await prisma.projectAlertChannel.count({ where: { projectId } })).toBe(3);
  });
});
