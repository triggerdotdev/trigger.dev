import {
  createChat,
  createDashboardAgentDb,
  type DashboardAgentDb,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { getAlert, listAlerts } from "~/v3/services/alerts/storage/alertStore.server";
import {
  alertEvaluationJobId,
  alertEvaluationJobs,
} from "~/v3/services/alerts/engine/evaluateAlertJob.server";
import { alertEngineTest as postgresTest } from "./helpers/alertEngineRedis";
import { applyAlertsMigration } from "./helpers/alertTables";
import type { PrismaClient } from "@trigger.dev/database";
import { signUserActorToken, type UserActorClaims } from "@trigger.dev/rbac";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

type Resource = { type: string; envType?: string };

vi.hoisted(() => {
  process.env.ALERTS_ENABLED = "1";
});

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
  userId: undefined as string | undefined,
  denied: undefined as { action: string; type: string; envType?: string } | undefined,
  grants: undefined as Array<{ action: string; type: string; envType?: string }> | undefined,
  patContexts: [] as Array<{ organizationId?: string; projectId?: string }>,
  userActorClaims: undefined as UserActorClaims | undefined,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return {
    prisma: proxy,
    $replica: proxy,
    $transaction: (db: PrismaClient, fn: Parameters<PrismaClient["$transaction"]>[0]) =>
      db.$transaction(fn),
    sqlDatabaseSchema: undefined,
  };
});

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateUserActor: async () => ({
      ok: true,
      userId: ctx.userActorClaims!.userId,
      claims: ctx.userActorClaims,
      ability: { can: () => true, canSuper: () => false },
    }),
    authenticatePat: async (_request: Request, patContext: { organizationId?: string }) => {
      ctx.patContexts.push(patContext);
      if (!ctx.userId) {
        return { ok: false, status: 401, error: "Invalid or Missing Access Token" };
      }
      return {
        ok: true,
        userId: ctx.userId,
        tokenId: "pat_test",
        lastAccessedAt: new Date(),
        ability: {
          can: (action: string, resource: Resource | Resource[]) =>
            [resource]
              .flat()
              .some((r) =>
                ctx.grants
                  ? ctx.grants.some(
                      (g) =>
                        g.action === action &&
                        g.type === r.type &&
                        (g.envType === undefined || g.envType === r.envType)
                    )
                  : !(
                      ctx.denied &&
                      ctx.denied.action === action &&
                      ctx.denied.type === r.type &&
                      (ctx.denied.envType === undefined || ctx.denied.envType === r.envType)
                    )
              ),
          canSuper: () => false,
        },
      };
    },
  },
}));

const { loader: listLoader, action: listAction } =
  await import("~/routes/api.v1.projects.$projectRef.monitoring-alerts");
const { createMonitoringAlertsAction } =
  await import("~/v3/services/alerts/createMonitoringAlertsAction.server");
const { action: alertAction, loader: alertLoader } =
  await import("~/routes/api.v1.projects.$projectRef.monitoring-alerts.$alertId");
const { action: analyzeAction } =
  await import("~/routes/api.v1.projects.$projectRef.monitoring-alerts.analyze-query");
const { loader: capabilitiesLoader } =
  await import("~/routes/api.v1.projects.$projectRef.monitoring-alert-capabilities");

// One synthetic capability with a non-mcp surface: every real registry entry currently
// includes "mcp", so this is the only way to exercise the surface-gate branch for real.
// Injected via createMonitoringAlertsAction's dep rather than mocking the registry module.
const noMcpSurfaceAction = createMonitoringAlertsAction({
  getCapability: (key: string) =>
    key === "test.no_mcp_surface"
      ? {
          key: "test.no_mcp_surface",
          area: "queues",
          signal: "metric",
          allowedKinds: ["threshold"],
          binding: {
            type: "query",
            template: "SELECT 1",
            table: "concurrency_metrics",
            minCadenceSec: 300,
          },
          minCadenceSec: 300,
          title: "Test capability",
          surfaces: ["alerts_page"],
          curated: false,
          freshness: "gauge",
        }
      : undefined,
});

let agentDbClient: Awaited<ReturnType<typeof createDashboardAgentDb>> | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  await applyAlertsMigration(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  ctx.agentDb = agentDbClient.db;
}

async function seed(
  prisma: PrismaClient,
  slugBase: string,
  alertsEnabled: boolean,
  platformAdmin = false,
  orgRole: "ADMIN" | "MEMBER" = "ADMIN"
) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const user = await prisma.user.create({
    data: {
      email: `${slug}@example.com`,
      authenticationMethod: "MAGIC_LINK",
      admin: platformAdmin,
    },
  });
  const organization = await prisma.organization.create({
    data: { title: slug, slug, featureFlags: { alertsEnabled } },
  });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: orgRole },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${slug.slice(0, 6)}`,
    },
  });
  return { user, organization, project, environment };
}

function jsonRequest(url: string, body?: unknown) {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer tr_pat_test", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  ctx.userId = undefined;
  ctx.denied = undefined;
  ctx.grants = undefined;
  ctx.patContexts = [];
  ctx.userActorClaims = undefined;
});

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("monitoring alerts API", () => {
  postgresTest("create -> list -> resolve", async ({ prisma, postgresContainer, engine }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "monalerts", true);
    ctx.userId = seeded.user.id;
    await createChat(ctx.agentDb, {
      id: "chat_1",
      organizationId: seeded.organization.id,
      userId: seeded.user.id,
    });

    const createResponse = await listAction({
      request: jsonRequest(
        `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
        {
          capabilityKey: "queue.depth",
          environment: "prod",
          params: { scope: { type: "queue", queue: "worker-1" } },
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
          behavior: {},
          notifiers: [{ type: "chat", chatId: "chat_1" }],
        }
      ),
      params: { projectRef: seeded.project.externalRef },
      context: {},
    } as any);
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(created.alert.capabilityKey).toBe("queue.depth");
    expect(created.alert.lifecycle).toBe("active");
    expect(await engine.getJob(alertEvaluationJobId(created.alert.id))).toBeTruthy();

    const listResponse = await listLoader({
      request: jsonRequest(
        `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts?environment=prod`
      ),
      params: { projectRef: seeded.project.externalRef },
      context: {},
    } as any);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json();
    expect(listed.alerts).toHaveLength(1);
    expect(listed.alerts[0].id).toBe(created.alert.id);

    // Force the alert into "needs_attention" so resolve has something to clear.
    await prisma.$executeRawUnsafe(
      `update "Alert" set attention = 'needs_attention' where id = '${created.alert.id}'`
    );

    const resolveResponse = await alertAction({
      request: jsonRequest(
        `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts/${created.alert.id}`,
        { action: "resolve" }
      ),
      params: { projectRef: seeded.project.externalRef, alertId: created.alert.id },
      context: {},
    } as any);
    expect(resolveResponse.status).toBe(200);
    const resolved = await resolveResponse.json();
    expect(resolved.alert.attention).toBe("clear");

    const stopResponse = await alertAction({
      request: jsonRequest(
        `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts/${created.alert.id}`,
        { action: "stop" }
      ),
      params: { projectRef: seeded.project.externalRef, alertId: created.alert.id },
      context: {},
    } as any);
    expect(stopResponse.status).toBe(200);
    expect(await engine.getJob(alertEvaluationJobId(created.alert.id))).toBeNull();
  });

  postgresTest(
    "create schedules through the injected lifecycle",
    async ({ prisma, postgresContainer, engine }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsdi", true);
      ctx.userId = seeded.user.id;
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });
      const jobs = alertEvaluationJobs(engine);
      const action = createMonitoringAlertsAction({
        lifecycle: { enqueue: jobs.enqueue, ack: jobs.ack },
      });

      const response = await action({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "queue", queue: "worker-1" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);

      expect(response.status).toBe(200);
      const created = await response.json();
      expect(await engine.getJob(alertEvaluationJobId(created.alert.id))).toBeTruthy();
    }
  );

  postgresTest("returns 403 when alertsEnabled is off", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "monalertsoff", false);
    ctx.userId = seeded.user.id;

    const response = await listLoader({
      request: jsonRequest(
        `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts?environment=prod`
      ),
      params: { projectRef: seeded.project.externalRef },
      context: {},
    } as any);
    expect(response.status).toBe(403);
  });

  postgresTest(
    "allows a platform admin even when alertsEnabled is off",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      // Ordinary org MEMBER: the bypass has to come from the platform admin
      // flag, not from org role.
      const seeded = await seed(prisma, "monalertsadmin", false, true, "MEMBER");
      ctx.userId = seeded.user.id;

      const response = await listLoader({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts?environment=prod`
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(200);
    }
  );

  postgresTest(
    "create stores params with the same shape as the agent route",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsparamsshape", true);
      ctx.userId = seeded.user.id;
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "queue", queue: "worker-1" }, windowSec: 60 },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(200);
      const created = await response.json();

      const row = await getAlert(ctx.prisma, {
        id: created.alert.id,
        projectId: seeded.project.id,
      });
      // Both create paths must store the same keys -- the query evaluator reads
      // params.windowSec regardless of which route created the alert.
      expect(Object.keys(row!.params).sort()).toEqual(["environmentId", "scope", "windowSec"]);
    }
  );

  postgresTest(
    "create rejects a malformed scope with no row",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsbadscope", true);
      ctx.userId = seeded.user.id;

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            // "queue" scope requires a `queue` field.
            params: { scope: { type: "queue" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create rejects an unknown capabilityKey with 422",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsunknowncap", true);
      ctx.userId = seeded.user.id;

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "does.not.exist",
            environment: "prod",
            params: {},
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(422);
    }
  );

  postgresTest(
    "create rejects a condition kind the capability doesn't allow",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertskind", true);
      ctx.userId = seeded.user.id;

      // queue.depth only allows "threshold"; "occurrence" is a different capability's kind.
      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "queue", queue: "worker-1" } },
            condition: { kind: "occurrence" },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(422);
    }
  );

  postgresTest(
    "create rejects a capability not offered on the mcp surface",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertssurface", true);
      ctx.userId = seeded.user.id;

      const response = await noMcpSurfaceAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "test.no_mcp_surface",
            environment: "prod",
            params: {},
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(422);
    }
  );

  postgresTest(
    "create rejects task scope for a queue capability",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertstaskqueue", true);
      ctx.userId = seeded.user.id;

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "task", taskIdentifier: "my-task" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create rejects a windowSec of 0 with no row",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertswindowzero", true);
      ctx.userId = seeded.user.id;

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "queue", queue: "worker-1" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 0 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create rejects a channel notifier that belongs to another project",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertschannel", true);
      const other = await seed(prisma, "monalertschannelother", true);
      ctx.userId = seeded.user.id;

      const foreignChannel = await prisma.projectAlertChannel.create({
        data: {
          friendlyId: `alertChannel_${Math.random().toString(36).slice(2, 10)}`,
          projectId: other.project.id,
          type: "EMAIL",
          name: "Foreign channel",
          properties: { email: "foreign@example.com" },
          alertTypes: [],
        },
      });

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "queue", queue: "worker-1" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "channel", channelId: foreignChannel.id }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(422);
    }
  );

  postgresTest(
    "create rejects a disabled channel notifier",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertschandisabled", true);
      ctx.userId = seeded.user.id;

      const disabledChannel = await prisma.projectAlertChannel.create({
        data: {
          friendlyId: `alertChannel_${Math.random().toString(36).slice(2, 10)}`,
          projectId: seeded.project.id,
          type: "EMAIL",
          name: "Disabled channel",
          properties: { email: "disabled@example.com" },
          alertTypes: [],
          enabled: false,
        },
      });

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "queue", queue: "worker-1" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "channel", channelId: disabledChannel.id }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(422);

      const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create rejects a chat notifier that belongs to another org with no row",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertschat", true);
      const other = await seed(prisma, "monalertschatother", true);
      ctx.userId = seeded.user.id;

      const foreignChatId = `chat_${Math.random().toString(36).slice(2, 10)}`;
      await createChat(ctx.agentDb, {
        id: foreignChatId,
        organizationId: other.organization.id,
        userId: other.user.id,
      });

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "queue", queue: "worker-1" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: foreignChatId }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create defaults an omitted scope to type all",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsdefaultscope", true);
      ctx.userId = seeded.user.id;
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: {},
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(200);
      const created = await response.json();

      const row = await getAlert(ctx.prisma, {
        id: created.alert.id,
        projectId: seeded.project.id,
      });
      expect((row!.params as { scope: unknown }).scope).toEqual({ type: "all" });
    }
  );

  postgresTest(
    "create rejects a chat notifier with no chatId",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertschatnoid", true);
      ctx.userId = seeded.user.id;

      const response = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "queue", queue: "worker-1" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest("create rejects failureRatePct above max", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "monalertsparammax", true);
    ctx.userId = seeded.user.id;

    const response = await listAction({
      request: jsonRequest(
        `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
        {
          capabilityKey: "health.execution",
          environment: "prod",
          params: {},
          condition: {
            kind: "state",
            stateKey: "execution",
            params: { failureRatePct: 999 },
          },
          behavior: {},
          notifiers: [{ type: "chat", chatId: "chat_1" }],
        }
      ),
      params: { projectRef: seeded.project.externalRef },
      context: {},
    } as any);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("above max");
  });

  postgresTest("create rejects unknown param key", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "monalertsparamunk", true);
    ctx.userId = seeded.user.id;

    const response = await listAction({
      request: jsonRequest(
        `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
        {
          capabilityKey: "health.flow",
          environment: "prod",
          params: {},
          condition: {
            kind: "state",
            stateKey: "flow",
            params: { nonExistentParam: 42 },
          },
          behavior: {},
          notifiers: [{ type: "chat", chatId: "chat_1" }],
        }
      ),
      params: { projectRef: seeded.project.externalRef },
      context: {},
    } as any);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("unknown param key");
  });

  describe("Limits condition fields", () => {
    async function post(
      prisma: PrismaClient,
      postgresContainer: { getConnectionUri(): string },
      capabilityKey: string,
      condition: Record<string, unknown>
    ) {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertshl", true);
      ctx.userId = seeded.user.id;
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });
      return listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey,
            environment: "prod",
            params: {},
            condition: { kind: "state", stateKey: capabilityKey, ...condition },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
    }

    postgresTest(
      "rejects components outside compositeOf",
      async ({ prisma, postgresContainer }) => {
        const response = await post(prisma, postgresContainer, "limits.all", {
          components: ["limits.api", "queue.depth"],
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("queue.depth");
      }
    );

    postgresTest(
      "rejects signals a selected component does not support",
      async ({ prisma, postgresContainer }) => {
        const response = await post(prisma, postgresContainer, "limits.all", {
          components: ["limits.api", "limits.queue"],
          signals: ["limited"],
        });
        expect(response.status).toBe(400);
      }
    );

    postgresTest("rejects empty signals", async ({ prisma, postgresContainer }) => {
      const response = await post(prisma, postgresContainer, "limits.api", { signals: [] });
      expect(response.status).toBe(400);
    });

    postgresTest("rejects a signal the capability lacks", async ({ prisma, postgresContainer }) => {
      const response = await post(prisma, postgresContainer, "limits.queue", {
        signals: ["limited"],
      });
      expect(response.status).toBe(400);
    });

    postgresTest("accepts and echoes the fields", async ({ prisma, postgresContainer }) => {
      const response = await post(prisma, postgresContainer, "limits.all", {
        compositeMode: "all",
        components: ["limits.api", "limits.webhooks.waiters"],
        signals: ["approaching"],
        params: { utilisationPct: 90 },
      });
      expect(response.status).toBe(200);
      const { alert } = await response.json();
      expect(alert.condition).toMatchObject({
        compositeMode: "all",
        components: ["limits.api", "limits.webhooks.waiters"],
        signals: ["approaching"],
      });
    });

    postgresTest(
      "still accepts a payload without the fields",
      async ({ prisma, postgresContainer }) => {
        const response = await post(prisma, postgresContainer, "limits.all", {});
        expect(response.status).toBe(200);
      }
    );
  });

  postgresTest("describe includes params for health.all", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "monalertsdescparams", true);
    ctx.userId = seeded.user.id;

    const response = await capabilitiesLoader({
      request: jsonRequest(
        `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alert-capabilities?area=health`
      ),
      params: { projectRef: seeded.project.externalRef },
      context: {},
    } as any);
    expect(response.status).toBe(200);
    const data = await response.json();
    const healthAll = data.capabilities.find((c: { key: string }) => c.key === "health.all");
    expect(healthAll).toBeDefined();
    expect(healthAll.binding.params).toBeDefined();
    expect(healthAll.binding.params.length).toBeGreaterThan(0);
    expect(healthAll.binding.params[0]).toHaveProperty("key");
    expect(healthAll.binding.params[0]).toHaveProperty("default");
  });

  postgresTest(
    "list falls back to the capability title for an unnamed alert",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsunnamed", true);
      ctx.userId = seeded.user.id;
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });

      const createResponse = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "all" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(createResponse.status).toBe(200);

      const listResponse = await listLoader({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts?environment=prod`
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(listResponse.status).toBe(200);
      const listed = await listResponse.json();
      expect(listed.alerts[0].name).toBe("Queue depth");
    }
  );

  postgresTest("create validates behavior.expiresAt", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "monalertsexpiry", true);
    ctx.userId = seeded.user.id;
    await createChat(ctx.agentDb, {
      id: "chat_1",
      organizationId: seeded.organization.id,
      userId: seeded.user.id,
    });

    const create = (expiresAt: string) =>
      listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "prod",
            params: { scope: { type: "all" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: { expiresAt },
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);

    for (const invalid of ["garbage", "2020-01-01T00:00:00Z"]) {
      const response = await create(invalid);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.issues.map((i: { path: unknown[] }) => i.path.join("."))).toContain(
        "behavior.expiresAt"
      );
    }

    const future = new Date(Date.now() + 24 * 3600_000).toISOString();
    const response = await create(future);
    expect(response.status).toBe(200);
    const created = await response.json();
    const stored = await getAlert(ctx.prisma, { id: created.alert.id });
    expect(stored?.expiresAt?.toISOString()).toBe(future);
  });
});

describe("monitoring alerts API RBAC", () => {
  function createRequest(seeded: Awaited<ReturnType<typeof seed>>) {
    return jsonRequest(
      `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
      {
        capabilityKey: "queue.depth",
        environment: "prod",
        params: { scope: { type: "all" } },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        behavior: {},
        notifiers: [{ type: "chat", chatId: "chat_1" }],
      }
    );
  }

  async function createAlert(seeded: Awaited<ReturnType<typeof seed>>) {
    await createChat(ctx.agentDb, {
      id: "chat_1",
      organizationId: seeded.organization.id,
      userId: seeded.user.id,
    });
    const response = await listAction({
      request: createRequest(seeded),
      params: { projectRef: seeded.project.externalRef },
      context: {},
    } as any);
    expect(response.status).toBe(200);
    return (await response.json()).alert as { id: string };
  }

  postgresTest(
    "an unrestricted PAT is authorized against the project's organization",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsrbacok", true);
      ctx.userId = seeded.user.id;

      await createAlert(seeded);

      expect(ctx.patContexts).toEqual([
        { organizationId: seeded.organization.id, projectId: seeded.project.id },
      ]);
    }
  );

  postgresTest(
    "a user-actor token scoped to another project of the same org gets 403",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsuat", true);
      const otherProject = await prisma.project.create({
        data: {
          name: "other",
          slug: `${seeded.project.slug}_other`,
          organizationId: seeded.organization.id,
          externalRef: `${seeded.project.externalRef}_other`,
        },
      });
      const otherEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "prod",
          type: "PRODUCTION",
          projectId: otherProject.id,
          organizationId: seeded.organization.id,
          apiKey: `${seeded.environment.apiKey}_other`,
          pkApiKey: `${seeded.environment.pkApiKey}_other`,
          shortcode: `${seeded.environment.shortcode}o`,
        },
      });

      async function listWithToken(environmentId: string) {
        ctx.userActorClaims = { userId: seeded.user.id, client: "dashboard-agent", environmentId };
        const token = await signUserActorToken(
          process.env.SESSION_SECRET ?? "test-session-secret",
          ctx.userActorClaims
        );
        return listLoader({
          request: new Request(
            `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts?environment=prod`,
            { headers: { Authorization: `Bearer ${token}` } }
          ),
          params: { projectRef: seeded.project.externalRef },
          context: {},
        } as any);
      }

      expect((await listWithToken(otherEnvironment.id)).status).toBe(403);
      expect((await listWithToken(seeded.environment.id)).status).toBe(200);
    }
  );

  postgresTest(
    "an environment-scoped token can't reach another environment's alerts",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsenvscope", true);
      ctx.userId = seeded.user.id;
      await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          projectId: seeded.project.id,
          organizationId: seeded.organization.id,
          orgMemberId: (
            await prisma.orgMember.findFirstOrThrow({
              where: { userId: seeded.user.id },
            })
          ).id,
          apiKey: `tr_dev_${seeded.project.id}`,
          pkApiKey: `pk_dev_${seeded.project.id}`,
          shortcode: `d${seeded.project.id.slice(0, 6)}`,
        },
      });
      const prodAlert = await createAlert(seeded);
      const devCreate = await listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`,
          {
            capabilityKey: "queue.depth",
            environment: "dev",
            params: { scope: { type: "all" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(devCreate.status).toBe(200);
      const devAlert = (await devCreate.json()).alert as { id: string; environmentId: string };
      await prisma.$executeRawUnsafe(
        `update "Alert" set attention = 'needs_attention' where id = '${devAlert.id}'`
      );

      ctx.userActorClaims = {
        userId: seeded.user.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };
      const token = await signUserActorToken(
        process.env.SESSION_SECRET ?? "test-session-secret",
        ctx.userActorClaims
      );
      const base = `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`;
      const tokenRequest = (url: string, body?: unknown) =>
        new Request(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const createBody = (environment: string) => ({
        capabilityKey: "queue.depth",
        environment,
        params: { scope: { type: "all" } },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        behavior: {},
        notifiers: [{ type: "chat", chatId: "chat_1" }],
      });
      const projectParams = { projectRef: seeded.project.externalRef };

      const list = (environment: string) =>
        listLoader({
          request: tokenRequest(`${base}?environment=${environment}`),
          params: projectParams,
          context: {},
        } as any);
      expect((await list("dev")).status).toBe(403);
      expect((await list("prod")).status).toBe(200);

      const create = (environment: string) =>
        listAction({
          request: tokenRequest(base, createBody(environment)),
          params: projectParams,
          context: {},
        } as any);
      expect((await create("dev")).status).toBe(403);
      expect(
        await listAlerts(ctx.prisma, {
          environmentId: devAlert.environmentId,
          projectId: seeded.project.id,
        })
      ).toHaveLength(1);
      expect((await create("prod")).status).toBe(200);

      const get = (alertId: string) =>
        alertLoader({
          request: tokenRequest(`${base}/${alertId}`),
          params: { ...projectParams, alertId },
          context: {},
        } as any);
      expect((await get(devAlert.id)).status).toBe(403);
      expect((await get(prodAlert.id)).status).toBe(200);

      for (const action of ["resolve", "stop"]) {
        const response = await alertAction({
          request: tokenRequest(`${base}/${devAlert.id}`, { action }),
          params: { ...projectParams, alertId: devAlert.id },
          context: {},
        } as any);
        expect(response.status).toBe(403);
      }
      const untouched = await getAlert(ctx.prisma, { id: devAlert.id });
      expect(untouched?.lifecycle).toBe("active");
      expect(untouched?.attention).toBe("needs_attention");

      const stopProd = await alertAction({
        request: tokenRequest(`${base}/${prodAlert.id}`, { action: "stop" }),
        params: { ...projectParams, alertId: prodAlert.id },
        context: {},
      } as any);
      expect(stopProd.status).toBe(200);
    }
  );

  postgresTest(
    "a PAT denied alerts write gets 403 on create, resolve and stop",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsrbacw", true);
      ctx.userId = seeded.user.id;
      const alert = await createAlert(seeded);
      await prisma.$executeRawUnsafe(
        `update "Alert" set attention = 'needs_attention' where id = '${alert.id}'`
      );
      ctx.denied = { action: "write", type: "alerts" };

      const createResponse = await listAction({
        request: createRequest(seeded),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(createResponse.status).toBe(403);

      for (const action of ["resolve", "stop"]) {
        const response = await alertAction({
          request: jsonRequest(
            `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts/${alert.id}`,
            { action }
          ),
          params: { projectRef: seeded.project.externalRef, alertId: alert.id },
          context: {},
        } as any);
        expect(response.status).toBe(403);
      }

      const alerts = await listAlerts(ctx.prisma, {
        environmentId: seeded.environment.id,
        projectId: seeded.project.id,
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].lifecycle).toBe("active");
      expect(alerts[0].attention).toBe("needs_attention");
    }
  );

  postgresTest(
    "a PAT denied alerts read gets 403 on list, get and capabilities",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsrbacr", true);
      ctx.userId = seeded.user.id;
      const alert = await createAlert(seeded);
      ctx.denied = { action: "read", type: "alerts" };

      const listResponse = await listLoader({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts?environment=prod`
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(listResponse.status).toBe(403);

      const getResponse = await alertLoader({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts/${alert.id}`
        ),
        params: { projectRef: seeded.project.externalRef, alertId: alert.id },
        context: {},
      } as any);
      expect(getResponse.status).toBe(403);

      const capabilitiesResponse = await capabilitiesLoader({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alert-capabilities`
        ),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(capabilitiesResponse.status).toBe(403);
    }
  );

  postgresTest(
    "preview with branch targets the branch environment",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "monalertsbranch", true);
      ctx.userId = seeded.user.id;
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });
      const preview = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview",
          type: "PREVIEW",
          isBranchableEnvironment: true,
          projectId: seeded.project.id,
          organizationId: seeded.organization.id,
          apiKey: `tr_preview_${seeded.project.id}`,
          pkApiKey: `pk_preview_${seeded.project.id}`,
          shortcode: `pv${seeded.project.id.slice(0, 6)}`,
        },
      });
      const branchEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview-feat-x",
          type: "PREVIEW",
          branchName: "feat-x",
          parentEnvironmentId: preview.id,
          projectId: seeded.project.id,
          organizationId: seeded.organization.id,
          apiKey: `tr_preview_feat_${seeded.project.id}`,
          pkApiKey: `pk_preview_feat_${seeded.project.id}`,
          shortcode: `pb${seeded.project.id.slice(0, 6)}`,
        },
      });

      await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview-old",
          type: "PREVIEW",
          branchName: "old",
          archivedAt: new Date(),
          parentEnvironmentId: preview.id,
          projectId: seeded.project.id,
          organizationId: seeded.organization.id,
          apiKey: `tr_preview_old_${seeded.project.id}`,
          pkApiKey: `pk_preview_old_${seeded.project.id}`,
          shortcode: `po${seeded.project.id.slice(0, 6)}`,
        },
      });

      const base = `https://example.test/api/v1/projects/${seeded.project.externalRef}/monitoring-alerts`;
      const createResponse = await listAction({
        request: jsonRequest(base, {
          capabilityKey: "queue.depth",
          environment: "preview",
          branch: "feat-x",
          params: { scope: { type: "all" } },
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
          behavior: {},
          notifiers: [{ type: "chat", chatId: "chat_1" }],
        }),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(createResponse.status).toBe(200);
      const created = await createResponse.json();
      const stored = await getAlert(ctx.prisma, { id: created.alert.id });
      expect(stored?.environmentId).toBe(branchEnv.id);

      const list = async (query: string) => {
        const response = await listLoader({
          request: jsonRequest(`${base}?${query}`),
          params: { projectRef: seeded.project.externalRef },
          context: {},
        } as any);
        expect(response.status).toBe(200);
        return ((await response.json()).alerts as { id: string }[]).map((a) => a.id);
      };
      expect(await list("environment=preview&branch=feat-x")).toEqual([created.alert.id]);
      expect(await list("environment=preview")).toEqual([]);

      const missing = await listLoader({
        request: jsonRequest(`${base}?environment=preview&branch=nope`),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(missing.status).toBe(404);

      expect(await list("environment=preview&branch=refs/heads/feat-x")).toEqual([
        created.alert.id,
      ]);

      const archived = await listLoader({
        request: jsonRequest(`${base}?environment=preview&branch=old`),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(archived.status).toBe(404);

      const nonPreviewList = await listLoader({
        request: jsonRequest(`${base}?environment=prod&branch=feat-x`),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(nonPreviewList.status).toBe(400);

      const nonPreviewCreate = await listAction({
        request: jsonRequest(base, {
          capabilityKey: "queue.depth",
          environment: "dev",
          branch: "feat-x",
          params: { scope: { type: "all" } },
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
          behavior: {},
          notifiers: [{ type: "chat", chatId: "chat_1" }],
        }),
        params: { projectRef: seeded.project.externalRef },
        context: {},
      } as any);
      expect(nonPreviewCreate.status).toBe(400);

      for (const branch of ["refs/unknown", "refs/heads/", ""]) {
        const invalidList = await listLoader({
          request: jsonRequest(`${base}?environment=preview&branch=${encodeURIComponent(branch)}`),
          params: { projectRef: seeded.project.externalRef },
          context: {},
        } as any);
        expect(invalidList.status, branch).toBe(400);

        const invalidCreate = await listAction({
          request: jsonRequest(base, {
            capabilityKey: "queue.depth",
            environment: "preview",
            branch,
            params: { scope: { type: "all" } },
            condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
          }),
          params: { projectRef: seeded.project.externalRef },
          context: {},
        } as any);
        expect(invalidCreate.status, branch).toBe(400);
      }
      expect(
        await listAlerts(ctx.prisma, { environmentId: preview.id, projectId: seeded.project.id })
      ).toEqual([]);
    }
  );
});

describe("monitoring alerts API environment-tier permissions", () => {
  function alertsUrl(projectRef: string, suffix = "") {
    return `https://example.test/api/v1/projects/${projectRef}/monitoring-alerts${suffix}`;
  }

  async function seedWithStaging(prisma: PrismaClient, slugBase: string) {
    const seeded = await seed(prisma, slugBase, true);
    await prisma.runtimeEnvironment.create({
      data: {
        slug: "stg",
        type: "STAGING",
        projectId: seeded.project.id,
        organizationId: seeded.organization.id,
        apiKey: `tr_stg_${seeded.project.id}`,
        pkApiKey: `pk_stg_${seeded.project.id}`,
        shortcode: `s${seeded.project.id.slice(0, 6)}`,
      },
    });
    await createChat(ctx.agentDb, {
      id: "chat_1",
      organizationId: seeded.organization.id,
      userId: seeded.user.id,
    });
    ctx.userId = seeded.user.id;
    return seeded;
  }

  function createIn(projectRef: string, environment: "dev" | "prod" | "staging") {
    return listAction({
      request: jsonRequest(alertsUrl(projectRef), {
        capabilityKey: "queue.depth",
        environment,
        params: { scope: { type: "queue", queue: "worker-1" } },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        behavior: {},
        notifiers: [{ type: "chat", chatId: "chat_1" }],
      }),
      params: { projectRef },
      context: {},
    } as any);
  }

  postgresTest(
    "a role denying alert writes in production allows them in staging",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedWithStaging(prisma, "tierwrite");
      const projectRef = seeded.project.externalRef;

      const prodAlert = await (await createIn(projectRef, "prod")).json();
      ctx.denied = { action: "write", type: "alerts", envType: "PRODUCTION" };

      expect((await createIn(projectRef, "prod")).status).toBe(403);
      expect((await createIn(projectRef, "staging")).status).toBe(200);

      for (const verb of ["resolve", "stop"]) {
        const response = await alertAction({
          request: jsonRequest(alertsUrl(projectRef, `/${prodAlert.alert.id}`), { action: verb }),
          params: { projectRef, alertId: prodAlert.alert.id },
          context: {},
        } as any);
        expect([verb, response.status]).toEqual([verb, 403]);
      }
    }
  );

  postgresTest(
    "a role denying alert reads in production hides them there only",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedWithStaging(prisma, "tierread");
      const projectRef = seeded.project.externalRef;

      const prodAlert = await (await createIn(projectRef, "prod")).json();
      ctx.denied = { action: "read", type: "alerts", envType: "PRODUCTION" };

      const list = (environment: string) =>
        listLoader({
          request: jsonRequest(alertsUrl(projectRef, `?environment=${environment}`)),
          params: { projectRef },
          context: {},
        } as any);
      expect((await list("prod")).status).toBe(403);
      expect((await list("staging")).status).toBe(200);

      const detail = await alertLoader({
        request: jsonRequest(alertsUrl(projectRef, `/${prodAlert.alert.id}`)),
        params: { projectRef, alertId: prodAlert.alert.id },
        context: {},
      } as any);
      expect(detail.status).toBe(403);
    }
  );

  async function seedWithDev(prisma: PrismaClient, slugBase: string) {
    const seeded = await seedWithStaging(prisma, slugBase);
    const member = await prisma.orgMember.findFirstOrThrow({
      where: { organizationId: seeded.organization.id, userId: seeded.user.id },
    });
    await prisma.runtimeEnvironment.create({
      data: {
        slug: "dev",
        type: "DEVELOPMENT",
        projectId: seeded.project.id,
        organizationId: seeded.organization.id,
        orgMemberId: member.id,
        apiKey: `tr_dev_${seeded.project.id}`,
        pkApiKey: `pk_dev_${seeded.project.id}`,
        shortcode: `d${seeded.project.id.slice(0, 6)}`,
      },
    });
    return seeded;
  }

  postgresTest(
    "a role granting alert writes only in development can create there and nowhere else",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedWithDev(prisma, "tierdevwrite");
      const projectRef = seeded.project.externalRef;
      ctx.grants = [{ action: "write", type: "alerts", envType: "DEVELOPMENT" }];

      expect((await createIn(projectRef, "dev")).status).toBe(200);

      const prod = await createIn(projectRef, "prod");
      expect(prod.status).toBe(403);
      expect((await prod.json()).error).toBe(
        "You don't have permission to manage alerts in this environment"
      );
    }
  );

  postgresTest(
    "a role granting alert reads only in development can list there and see capabilities",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedWithDev(prisma, "tierdevread");
      const projectRef = seeded.project.externalRef;
      ctx.grants = [{ action: "read", type: "alerts", envType: "DEVELOPMENT" }];

      const list = await listLoader({
        request: jsonRequest(alertsUrl(projectRef, "?environment=dev")),
        params: { projectRef },
        context: {},
      } as any);
      expect(list.status).toBe(200);

      const capabilities = await capabilitiesLoader({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${projectRef}/monitoring-alert-capabilities`
        ),
        params: { projectRef },
        context: {},
      } as any);
      expect(capabilities.status).toBe(200);
    }
  );

  postgresTest(
    "a role with no alert grant is stopped at the gate before body validation",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedWithDev(prisma, "tiernogrant");
      const projectRef = seeded.project.externalRef;
      ctx.grants = [{ action: "write", type: "runs" }];

      const response = await listAction({
        request: jsonRequest(alertsUrl(projectRef), { invalid: true }),
        params: { projectRef },
        context: {},
      } as any);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("Unauthorized");
    }
  );

  describe("query alerts", () => {
    const COUNT_QUERY = "SELECT count() AS failures FROM runs WHERE status = 'Failed'";

    async function setup(prisma: PrismaClient, connectionUri: string, slug: string) {
      await boot(prisma, connectionUri);
      const seeded = await seed(prisma, slug, true);
      ctx.userId = seeded.user.id;
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });
      return seeded;
    }

    function createQueryAlert(projectRef: string, overrides: Record<string, unknown>) {
      return listAction({
        request: jsonRequest(
          `https://example.test/api/v1/projects/${projectRef}/monitoring-alerts`,
          {
            capabilityKey: "custom.query",
            environment: "prod",
            params: { scope: { type: "all" } },
            condition: { kind: "threshold", operator: ">", value: 5, windowSec: 3600 },
            behavior: {},
            notifiers: [{ type: "chat", chatId: "chat_1" }],
            query: COUNT_QUERY,
            signal: { mode: "threshold" },
            ...overrides,
          }
        ),
        params: { projectRef },
        context: {},
      } as any);
    }

    postgresTest(
      "creates a query alert with a server-derived signal",
      async ({ prisma, postgresContainer }) => {
        const seeded = await setup(prisma, postgresContainer.getConnectionUri(), "qalertok");
        const response = await createQueryAlert(seeded.project.externalRef, {});
        expect(response.status).toBe(200);
        const { alert } = await response.json();
        const row = await getAlert(ctx.prisma, { id: alert.id, projectId: seeded.project.id });
        expect(row!.capabilityKey).toBe("custom.query");
        const signal = (row!.params as any).querySignal;
        expect(signal.measure).toBe("failures");
        expect(signal.v).toBe(1);
        expect(signal.sources[0].windowColumn).toBeTruthy();
      }
    );

    postgresTest(
      "keeps the curated absence floor, while a query absence uses its source floor",
      async ({ prisma, postgresContainer }) => {
        const seeded = await setup(prisma, postgresContainer.getConnectionUri(), "qalertfloor");
        const absence = { kind: "absence", quietWindowSec: 600 };
        const curated = await createQueryAlert(seeded.project.externalRef, {
          capabilityKey: "runs.created",
          condition: absence,
          query: undefined,
          signal: undefined,
        });
        expect(curated.status).toBe(422);
        expect((await curated.json()).error).toBe("Quiet window must be at least 1800 seconds");

        const query = await createQueryAlert(seeded.project.externalRef, {
          condition: absence,
          signal: { mode: "absence" },
        });
        expect(query.status).toBe(200);
      }
    );

    postgresTest("rejects query on a curated capability", async ({ prisma, postgresContainer }) => {
      const seeded = await setup(prisma, postgresContainer.getConnectionUri(), "qalertcurated");
      const response = await createQueryAlert(seeded.project.externalRef, {
        capabilityKey: "queue.depth",
        params: { scope: { type: "queue", queue: "worker-1" } },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
      });
      expect(response.status).toBe(400);
    });

    postgresTest(
      "rejects an invalid query with the analyzer message",
      async ({ prisma, postgresContainer }) => {
        const seeded = await setup(prisma, postgresContainer.getConnectionUri(), "qalertbad");
        const response = await createQueryAlert(seeded.project.externalRef, {
          query: `${COUNT_QUERY} LIMIT 5`,
        });
        expect(response.status).toBe(422);
        expect((await response.json()).error).toBeTruthy();
      }
    );

    postgresTest(
      "analyze-query returns 403 when alerts are off",
      async ({ prisma, postgresContainer }) => {
        await boot(prisma, postgresContainer.getConnectionUri());
        const seeded = await seed(prisma, "qalertoff", false);
        ctx.userId = seeded.user.id;
        const projectRef = seeded.project.externalRef;
        const response = await analyzeAction({
          request: jsonRequest(
            `https://example.test/api/v1/projects/${projectRef}/monitoring-alerts/analyze-query`,
            { query: COUNT_QUERY }
          ),
          params: { projectRef },
          context: {},
        } as any);
        expect(response.status).toBe(403);
      }
    );

    postgresTest(
      "analyze-query returns 404 for an unknown project",
      async ({ prisma, postgresContainer }) => {
        await setup(prisma, postgresContainer.getConnectionUri(), "qalert404");
        const response = await analyzeAction({
          request: jsonRequest(
            "https://example.test/api/v1/projects/proj_missing/monitoring-alerts/analyze-query",
            { query: COUNT_QUERY }
          ),
          params: { projectRef: "proj_missing" },
          context: {},
        } as any);
        expect(response.status).toBe(404);
      }
    );

    postgresTest("analyze-query returns modes", async ({ prisma, postgresContainer }) => {
      const seeded = await setup(prisma, postgresContainer.getConnectionUri(), "qalertanalyze");
      const projectRef = seeded.project.externalRef;
      const analyze = async (query: string) => {
        const response = await analyzeAction({
          request: jsonRequest(
            `https://example.test/api/v1/projects/${projectRef}/monitoring-alerts/analyze-query`,
            { query }
          ),
          params: { projectRef },
          context: {},
        } as any);
        expect(response.status).toBe(200);
        return (await response.json()).analysis;
      };

      const scalar = await analyze(COUNT_QUERY);
      expect(scalar.modes.map((m: any) => m.mode)).toContain("threshold");
    });
  });
});
