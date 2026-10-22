import {
  createChat,
  createDashboardAgentDb,
  type DashboardAgentDb,
} from "@internal/dashboard-agent-db";
import { alertParamsSchema } from "@internal/alert-contracts";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { getAlert, listAlerts } from "~/v3/services/alerts/storage/alertStore.server";
import { alertEvaluationJobId } from "~/v3/services/alerts/engine/evaluateAlertJob.server";
import { alertEngineTest as postgresTest } from "./helpers/alertEngineRedis";
import { applyAlertsMigration } from "./helpers/alertTables";
import type { PrismaClient } from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
  uatClaims: undefined as { userId: string; environmentId: string; client: string } | undefined,
  tokenCap: [] as string[],
  roleAllowsAlertWrites: true,
  sessionCalls: [] as unknown[],
  deniedWriteEnvType: undefined as string | undefined,
  roleAlertWriteEnvTypes: undefined as string[] | undefined,
  signedCap: undefined as string[] | undefined,
  alertContext: undefined as
    | { ok: true; environment: AuthenticatedEnvironment }
    | { ok: false; code: string; error: string }
    | undefined,
}));

vi.hoisted(() => {
  process.env.QUEUE_METRICS_EMIT_ENABLED = "1";
  process.env.QUEUE_METRICS_CONSUMER_ENABLED = "1";
  process.env.ALERTS_ENABLED = "1";
});

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

vi.mock("~/services/uatRoutePreamble.server", () => ({
  authenticateUatOrApiRequest: async () =>
    ctx.uatClaims
      ? {
          authenticationResult: {
            type: "personalAccessToken",
            result: { userId: ctx.uatClaims.userId },
          },
          userActor: ctx.uatClaims,
        }
      : undefined,
}));

vi.mock("@trigger.dev/rbac", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  signUserActorToken: async (_secret: string, claims: { cap?: string[] }) => {
    ctx.signedCap = claims.cap;
    return "tr_uat_test";
  },
}));

vi.mock("~/services/rbac.server", async () => {
  const { buildJwtAbility } = await import("@trigger.dev/rbac");
  const roleAllows = (action: string) => action !== "write" || ctx.roleAllowsAlertWrites;
  return {
    rbac: {
      authenticateUserActor: async () => {
        const cap = buildJwtAbility(ctx.tokenCap);
        return {
          ok: true,
          ability: {
            can: (action: string, resource: { type: string; envType?: string }) =>
              cap.can(action, resource) &&
              roleAllows(action) &&
              !(action === "write" && resource.envType === ctx.deniedWriteEnvType),
            canSuper: () => false,
          },
        };
      },
      authenticateSession: async (_request: Request, context: unknown) => {
        ctx.sessionCalls.push(context);
        return {
          ok: true,
          ability: {
            can: (action: string, resource: { type: string; envType?: string }) =>
              roleAllows(action) &&
              (action !== "write" ||
                !ctx.roleAlertWriteEnvTypes ||
                ctx.roleAlertWriteEnvTypes.includes(resource.envType ?? "")),
            canSuper: () => false,
          },
        };
      },
    },
  };
});

vi.mock("~/services/dashboardAgentAlertContext.server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveAgentAlertContext: async (params: {
      claimedEnvironmentId?: string;
      environmentId: string;
    }) => {
      if (params.claimedEnvironmentId && params.claimedEnvironmentId !== params.environmentId) {
        return {
          ok: false,
          code: "environment_mismatch",
          error: "That environment isn't the one this chat is open in.",
        };
      }
      return ctx.alertContext;
    },
  };
});

vi.mock("~/services/dashboardAgentWatches.server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    authorizeWatchEnvironmentById: async () =>
      ctx.alertContext?.ok ? ctx.alertContext.environment : null,
  };
});

vi.mock("~/services/logger.server", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));

vi.mock("~/v3/alertsRateLimiter.server", () => ({
  alertsRateLimiter: { check: async () => ({ allowed: true }) },
}));

const { loader, action } = await import("~/routes/api.v1.dashboard-agent.monitoring-alerts");
const { DASHBOARD_AGENT_UAT_CAP, mintDashboardAgentUserActorToken } =
  await import("~/services/dashboardAgent.server");

let agentDbClient: Awaited<ReturnType<typeof createDashboardAgentDb>> | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  await applyAlertsMigration(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  ctx.agentDb = agentDbClient.db;
}

function makeEnv(
  orgId: string,
  projectId: string,
  envId: string,
  orgSlug: string,
  projectRef: string,
  featureFlags: Record<string, unknown> = { alertsEnabled: true }
): AuthenticatedEnvironment {
  return {
    id: envId,
    type: "PRODUCTION",
    slug: "prod",
    organizationId: orgId,
    organization: { id: orgId, slug: orgSlug, title: orgSlug, featureFlags },
    project: { id: projectId, slug: orgSlug, name: orgSlug, externalRef: projectRef },
  } as AuthenticatedEnvironment;
}

const ENV_TYPE: Record<string, "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT"> = {
  prod: "PRODUCTION",
  staging: "STAGING",
  preview: "PREVIEW",
  dev: "DEVELOPMENT",
};

/** A real org/project with one runtime environment row per requested slug, for tests
 * that exercise slug resolution (`resolveMonitoringAlertsEnvironment` hits the DB). */
async function seedProjectWithEnvironments(
  prisma: PrismaClient,
  slugBase: string,
  envSlugs: string[]
) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: { title: slug, slug, featureFlags: { alertsEnabled: true } },
  });
  const orgMember = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environments: Record<string, { id: string }> = {};
  for (const envSlug of envSlugs) {
    environments[envSlug] = await prisma.runtimeEnvironment.create({
      data: {
        slug: envSlug,
        type: ENV_TYPE[envSlug],
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${envSlug}_${slug}`,
        pkApiKey: `pk_${envSlug}_${slug}`,
        shortcode: `p${slug.slice(0, 4)}${envSlug.slice(0, 2)}`,
        // DEVELOPMENT environments are per-member; findEnvironmentBySlug only
        // resolves one whose orgMember matches the acting user.
        orgMemberId: envSlug === "dev" ? orgMember.id : undefined,
      },
    });
  }
  return { user, organization, project, environments };
}

function jsonRequest(url: string, body?: unknown) {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer uat_test", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  ctx.uatClaims = undefined;
  ctx.alertContext = undefined;
  ctx.tokenCap = [...DASHBOARD_AGENT_UAT_CAP, "write:alerts"];
  ctx.roleAllowsAlertWrites = true;
  ctx.sessionCalls = [];
  ctx.deniedWriteEnvType = undefined;
  ctx.roleAlertWriteEnvTypes = undefined;
});

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("dashboard-agent monitoring alerts route", () => {
  postgresTest("create rejects a malformed expiresAt", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seedProjectWithEnvironments(prisma, "badexpiry", ["prod"]);

    const env = makeEnv(
      seeded.organization.id,
      seeded.project.id,
      seeded.environments.prod.id,
      seeded.organization.slug,
      seeded.project.externalRef
    );
    ctx.uatClaims = { userId: seeded.user.id, environmentId: env.id, client: "dashboard-agent" };
    ctx.alertContext = { ok: true, environment: env };

    const response = await action({
      request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
        chatId: "chat_1",
        capabilityKey: "queue.depth",
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        behavior: { expiresAt: "garbage" },
      }),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(400);
    const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
    expect(alerts).toHaveLength(0);
  });

  postgresTest(
    "create rejects an environment slug unknown to this project",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedProjectWithEnvironments(prisma, "envslugunknown", ["prod"]);

      const env = makeEnv(
        seeded.organization.id,
        seeded.project.id,
        seeded.environments.prod.id,
        seeded.organization.slug,
        seeded.project.externalRef
      );
      ctx.uatClaims = { userId: seeded.user.id, environmentId: env.id, client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          environment: "staging",
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("staging");

      const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create rejects an environment slug that resolves to a different environment than the chat's",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedProjectWithEnvironments(prisma, "envslugmismatch", ["prod", "dev"]);

      const env = makeEnv(
        seeded.organization.id,
        seeded.project.id,
        seeded.environments.prod.id,
        seeded.organization.slug,
        seeded.project.externalRef
      );
      ctx.uatClaims = { userId: seeded.user.id, environmentId: env.id, client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          // The chat is open in prod; asking for dev must be rejected, not silently switched.
          environment: "dev",
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.code).toBe("environment_mismatch");

      const alerts = await listAlerts(ctx.prisma, { projectId: seeded.project.id });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create rejects a channel notifier from another project",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug2", "proj_ref2");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
          notifiers: [{ type: "channel", channelId: "chan_foreign" }],
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("chan_foreign");

      const alerts = await listAlerts(ctx.prisma, { projectId: "proj_1" });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create rejects a chat notifier from another org",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug9", "proj_ref9");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const foreignChatId = `chat_${Math.random().toString(36).slice(2, 10)}`;
      await createChat(ctx.agentDb, {
        id: foreignChatId,
        organizationId: "org_2",
        userId: "user_2",
      });

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
          notifiers: [{ type: "chat", chatId: foreignChatId }],
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: "proj_1" });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create stores params that satisfy alertParamsSchema",
    async ({ prisma, postgresContainer, engine }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug6", "proj_ref6");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      const created = await response.json();
      expect(await engine.getJob(alertEvaluationJobId(created.alert.id))).toBeTruthy();

      const row = await getAlert(ctx.prisma, { id: created.alert.id, projectId: "proj_1" });
      expect(() => alertParamsSchema.parse(row!.params)).not.toThrow();
    }
  );

  postgresTest(
    "create stores params with the same shape as the public API route",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug11", "proj_ref11");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          scope: { type: "queue", queue: "worker-1" },
          windowSec: 60,
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      const created = await response.json();

      const row = await getAlert(ctx.prisma, { id: created.alert.id, projectId: "proj_1" });
      // Both create paths must store the same keys -- the query evaluator reads
      // params.windowSec regardless of which route created the alert.
      expect(Object.keys(row!.params).sort()).toEqual(["environmentId", "scope", "windowSec"]);
    }
  );

  postgresTest(
    "list returns 403 for a non-admin when alertsEnabled is off",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const user = await prisma.user.create({
        data: { email: "agent-gate-nonadmin@example.com", authenticationMethod: "MAGIC_LINK" },
      });

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug4", "proj_ref4", {
        alertsEnabled: false,
      });
      ctx.uatClaims = { userId: user.id, environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await loader({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts?chatId=chat_1"),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(403);
    }
  );

  postgresTest(
    "list allows a platform admin when alertsEnabled is off",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const user = await prisma.user.create({
        data: {
          email: "agent-gate-admin@example.com",
          authenticationMethod: "MAGIC_LINK",
          admin: true,
        },
      });

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug5", "proj_ref5", {
        alertsEnabled: false,
      });
      ctx.uatClaims = { userId: user.id, environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await loader({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts?chatId=chat_1"),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
    }
  );

  postgresTest(
    "create rejects task scope for a queue capability",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug3", "proj_ref3");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          scope: { type: "task", taskIdentifier: "my-task" },
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: "proj_1" });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create rejects a condition kind the capability doesn't allow",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug7", "proj_ref7");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          condition: { kind: "occurrence" },
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: "proj_1" });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "capabilities listing returns 403 for a non-admin when alertsEnabled is off",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const user = await prisma.user.create({
        data: { email: "agent-caps-nonadmin@example.com", authenticationMethod: "MAGIC_LINK" },
      });

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug8", "proj_ref8", {
        alertsEnabled: false,
      });
      ctx.uatClaims = { userId: user.id, environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await loader({
        request: jsonRequest(
          "https://test/api/v1/dashboard-agent/monitoring-alerts?capabilities=true"
        ),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(403);
    }
  );

  postgresTest(
    "create rejects a malformed scope with no row",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug10", "proj_ref10");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          // "queue" scope requires a `queue` field.
          scope: { type: "queue" },
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(400);

      const alerts = await listAlerts(ctx.prisma, { projectId: "proj_1" });
      expect(alerts).toHaveLength(0);
    }
  );

  postgresTest(
    "create fills chatId for an explicit chat notifier with none",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug13", "proj_ref13");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: "org_1",
        userId: "user_1",
      });

      const response = await action({
        request: jsonRequest("https://test/api/v1/dashboard-agent/monitoring-alerts", {
          chatId: "chat_1",
          capabilityKey: "queue.depth",
          condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
          notifiers: [{ type: "chat" }],
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      const created = await response.json();

      const row = await getAlert(ctx.prisma, { id: created.alert.id, projectId: "proj_1" });
      expect(row!.notifiers).toEqual([{ type: "chat", chatId: "chat_1" }]);
    }
  );

  postgresTest(
    "capabilities listing includes allowedScopes",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      const env = makeEnv("org_1", "proj_1", "env_prod", "slug12", "proj_ref12");
      ctx.uatClaims = { userId: "user_1", environmentId: "env_prod", client: "dashboard-agent" };
      ctx.alertContext = { ok: true, environment: env };

      const response = await loader({
        request: jsonRequest(
          "https://test/api/v1/dashboard-agent/monitoring-alerts?capabilities=true"
        ),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      const body = await response.json();
      const queueDepth = body.capabilities.find((c: { key: string }) => c.key === "queue.depth");
      expect(queueDepth.allowedScopes).toContain("queue");
      expect(queueDepth.allowedScopes).not.toContain("task");
      const healthAll = body.capabilities.find((c: { key: string }) => c.key === "health.all");
      expect(healthAll.allowedScopes).toEqual(["all"]);
      expect(healthAll.params).toBeDefined();
      expect(healthAll.params.length).toBeGreaterThan(0);
    }
  );
});

describe("dashboard-agent monitoring alerts authorization", () => {
  const ALERTS_URL = "https://test/api/v1/dashboard-agent/monitoring-alerts";
  const CREATE_BODY = {
    chatId: "chat_1",
    capabilityKey: "queue.depth",
    condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
  };

  async function seedAuthorized(prisma: PrismaClient, slugBase: string) {
    const seeded = await seedProjectWithEnvironments(prisma, slugBase, ["prod"]);
    const env = makeEnv(
      seeded.organization.id,
      seeded.project.id,
      seeded.environments.prod.id,
      seeded.organization.slug,
      seeded.project.externalRef
    );
    ctx.uatClaims = { userId: seeded.user.id, environmentId: env.id, client: "dashboard-agent" };
    ctx.alertContext = { ok: true, environment: env };
    return seeded;
  }

  async function mintedCap(userId: string, environmentId: string, alertWrites: boolean) {
    ctx.signedCap = undefined;
    await mintDashboardAgentUserActorToken(userId, {
      environmentId,
      ...(alertWrites ? { alertWrites: { request: new Request("https://test/") } } : {}),
    });
    return ctx.signedCap ?? [];
  }

  postgresTest(
    "the base token reads alerts but cannot create or resolve them",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedAuthorized(prisma, "basecap");
      ctx.tokenCap = [...DASHBOARD_AGENT_UAT_CAP];

      const created = await action({
        request: jsonRequest(ALERTS_URL, CREATE_BODY),
        params: {},
        context: {},
      } as any);
      expect(created.status).toBe(403);
      expect(await listAlerts(ctx.prisma, { projectId: seeded.project.id })).toHaveLength(0);

      const resolved = await action({
        request: jsonRequest(ALERTS_URL, { chatId: "chat_1", alertId: "alert_1" }),
        params: {},
        context: {},
      } as any);
      expect(resolved.status).toBe(403);

      const listed = await loader({
        request: jsonRequest(`${ALERTS_URL}?chatId=chat_1`),
        params: {},
        context: {},
      } as any);
      expect(listed.status).toBe(200);

      const capabilities = await loader({
        request: jsonRequest(`${ALERTS_URL}?capabilities=true`),
        params: {},
        context: {},
      } as any);
      expect(capabilities.status).toBe(200);
    }
  );

  postgresTest(
    "a token without read:alerts cannot list alerts or capabilities",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await seedAuthorized(prisma, "noread");
      ctx.tokenCap = DASHBOARD_AGENT_UAT_CAP.filter((c) => c !== "read:alerts");

      const listed = await loader({
        request: jsonRequest(`${ALERTS_URL}?chatId=chat_1`),
        params: {},
        context: {},
      } as any);
      expect(listed.status).toBe(403);

      const capabilities = await loader({
        request: jsonRequest(`${ALERTS_URL}?capabilities=true`),
        params: {},
        context: {},
      } as any);
      expect(capabilities.status).toBe(403);
    }
  );

  postgresTest(
    "a role that denies alert writes in production still allows them in development",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedAuthorized(prisma, "envtier");
      ctx.deniedWriteEnvType = "PRODUCTION";

      const prod = await action({
        request: jsonRequest(ALERTS_URL, CREATE_BODY),
        params: {},
        context: {},
      } as any);
      expect(prod.status).toBe(403);

      const prodResolve = await action({
        request: jsonRequest(ALERTS_URL, { chatId: "chat_1", alertId: "alert_1" }),
        params: {},
        context: {},
      } as any);
      expect(prodResolve.status).toBe(403);

      const prodEnv = ctx.alertContext as { ok: true; environment: AuthenticatedEnvironment };
      ctx.alertContext = {
        ok: true,
        environment: { ...prodEnv.environment, type: "DEVELOPMENT" },
      };
      const dev = await action({
        request: jsonRequest(ALERTS_URL, CREATE_BODY),
        params: {},
        context: {},
      } as any);
      expect(dev.status).toBe(200);
      expect(await listAlerts(ctx.prisma, { projectId: seeded.project.id })).toHaveLength(1);
    }
  );

  postgresTest(
    "a write-capped token still cannot create when the user's role lacks write:alerts",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedAuthorized(prisma, "norole");
      ctx.roleAllowsAlertWrites = false;

      const response = await action({
        request: jsonRequest(ALERTS_URL, CREATE_BODY),
        params: {},
        context: {},
      } as any);
      expect(response.status).toBe(403);
      expect(await listAlerts(ctx.prisma, { projectId: seeded.project.id })).toHaveLength(0);
    }
  );

  postgresTest(
    "mints the write cap only when asked for and the user's role allows it",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedAuthorized(prisma, "mintcap");
      const envId = seeded.environments.prod.id;

      expect(await mintedCap(seeded.user.id, envId, false)).not.toContain("write:alerts");
      expect(ctx.sessionCalls).toHaveLength(0);

      ctx.roleAllowsAlertWrites = false;
      expect(await mintedCap(seeded.user.id, envId, true)).not.toContain("write:alerts");

      ctx.roleAllowsAlertWrites = true;
      ctx.tokenCap = await mintedCap(seeded.user.id, envId, true);
      expect(ctx.tokenCap).toContain("write:alerts");
      expect(ctx.sessionCalls.at(-1)).toEqual({
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
      });

      const response = await action({
        request: jsonRequest(ALERTS_URL, CREATE_BODY),
        params: {},
        context: {},
      } as any);
      expect(response.status).toBe(200);
      expect(await listAlerts(ctx.prisma, { projectId: seeded.project.id })).toHaveLength(1);
    }
  );

  postgresTest(
    "mints the write cap only for environments where the role allows alert writes",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedProjectWithEnvironments(prisma, "minttier", ["prod", "dev"]);
      ctx.roleAlertWriteEnvTypes = ["DEVELOPMENT"];

      expect(await mintedCap(seeded.user.id, seeded.environments.dev.id, true)).toContain(
        "write:alerts"
      );
      expect(await mintedCap(seeded.user.id, seeded.environments.prod.id, true)).not.toContain(
        "write:alerts"
      );
    }
  );
});
