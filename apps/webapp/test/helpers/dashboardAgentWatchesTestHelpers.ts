import {
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { WatchDraft, WatchSpec } from "@internal/dashboard-agent-contracts";
import type { PrismaClient } from "@trigger.dev/database";
import type { WatchCheckDeps, WatchRunRow } from "~/services/dashboardAgentWatchChecks";
import type { createDashboardAgentWatch as CreateDashboardAgentWatchFunction } from "~/services/dashboardAgentWatches.server";

export type DashboardAgentWatchesTestContext = {
  prisma: PrismaClient;
  agentDb: DashboardAgentDb;
  canAccess: boolean;
  actor:
    | undefined
    | { userId: string; client?: string; environmentId?: string; organizationId?: string };
  /** Every task id the suite would have triggered for real. */
  triggered: string[];
};

async function seedDashboardAgentWatchTestData(prisma: PrismaClient, slugBase: string) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
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

export type Seeded = Awaited<ReturnType<typeof seedDashboardAgentWatchTestData>>;

export const RUN_START: WatchSpec = {
  kind: "run_start",
  runId: "run_1",
  checkEveryMinutes: 1,
  maxHours: 2,
  note: "tell me when it starts",
};

export const BACKLOG: WatchSpec = {
  kind: "backlog_drain",
  queue: "task/my-task",
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me when it drains",
};

export const HEALTH: WatchSpec = {
  kind: "health_recovery",
  report: "health",
  fromSeverity: "warn",
  checkEveryMinutes: 5,
  maxHours: 6,
  note: "tell me when health recovers",
};

/** A run that exists for target validation and is gone when the immediate check reads it. */
export function readRunOnce(first: WatchRunRow) {
  let calls = 0;
  return async () => (calls++ === 0 ? first : null);
}

/** A configured card, with both follow-ups off unless a test turns one on. */
export function draftFor(
  spec: WatchSpec,
  followUp: Partial<WatchDraft["followUp"]> = {}
): WatchDraft {
  return {
    spec,
    followUp: { investigateOnAttention: false, notifyExternally: false, ...followUp },
  };
}

type CreateDashboardAgentWatch = typeof CreateDashboardAgentWatchFunction;

export class DashboardAgentWatchesTestHarness {
  private agentDbClient: DashboardAgentDbClient | undefined;

  constructor(
    private readonly ctx: DashboardAgentWatchesTestContext,
    private readonly createDashboardAgentWatch: CreateDashboardAgentWatch
  ) {}

  reset() {
    this.ctx.canAccess = true;
    this.ctx.actor = undefined;
    this.ctx.triggered.length = 0;
  }

  async boot(prisma: PrismaClient, connectionUri: string) {
    this.ctx.prisma = prisma;
    await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
    // A pool, not a single connection: concurrent-create tests need the advisory lock to span connections.
    this.agentDbClient = createDashboardAgentDb(connectionUri, { max: 8 });
    this.ctx.agentDb = this.agentDbClient.db;
  }

  async close() {
    await this.agentDbClient?.close();
    this.agentDbClient = undefined;
  }

  seed(prisma: PrismaClient, slugBase: string) {
    return seedDashboardAgentWatchTestData(prisma, slugBase);
  }

  authenticated(seeded: Seeded) {
    return {
      id: seeded.environment.id,
      organizationId: seeded.organization.id,
      projectId: seeded.project.id,
      slug: "prod",
      type: "PRODUCTION",
      project: { id: seeded.project.id, externalRef: seeded.project.externalRef },
      organization: { id: seeded.organization.id, slug: seeded.organization.slug },
    } as any;
  }

  async seedChat(seeded: Seeded, chatId = "chat_1") {
    await createChat(this.ctx.agentDb, {
      id: chatId,
      organizationId: seeded.organization.id,
      userId: seeded.user.id,
    });
    return chatId;
  }

  runRow(overrides: Partial<WatchRunRow> = {}): WatchRunRow {
    return {
      friendlyId: "run_1",
      status: "PENDING",
      queue: "task/my-task",
      createdAt: new Date(),
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      delayUntil: null,
      ...overrides,
    };
  }

  /** Injected readers. Defaults keep every condition pending with a live target. */
  fakeCheckDeps(overrides: Partial<WatchCheckDeps> = {}): WatchCheckDeps {
    return {
      readRun: async () => this.runRow(),
      queueExists: async () => true,
      readQueueDepth: async () => ({ depth: 7, source: "live_queue", current: true }),
      readQueueOldestAge: async () => ({
        ageMs: 30_000,
        source: "live_queue",
        current: true,
      }),
      readErrorRecurrence: async () => null,
      readHealth: async () => ({ trustworthy: true, severity: "warn" }),
      ...overrides,
    };
  }

  create(args: {
    seeded: Seeded;
    spec?: WatchSpec;
    chatId?: string;
    environmentId?: string;
    investigateOnAttention?: boolean;
    watchId?: string;
    checkDeps?: Partial<WatchCheckDeps>;
    scheduled?: Array<{ watchId: string; token: string; tick: number }>;
    onSchedule?: () => void;
  }) {
    const environment = this.authenticated(args.seeded);
    return this.createDashboardAgentWatch({
      environment: args.environmentId ? { ...environment, id: args.environmentId } : environment,
      userId: args.seeded.user.id,
      chatId: args.chatId ?? "chat_1",
      spec: args.spec ?? RUN_START,
      investigateOnAttention: args.investigateOnAttention,
      watchId: args.watchId,
      deps: {
        configured: () => true,
        checkDeps: () => this.fakeCheckDeps(args.checkDeps),
        scheduleTick: async (params) => {
          args.onSchedule?.();
          args.scheduled?.push({
            watchId: params.watchId,
            token: params.token,
            tick: params.tick,
          });
        },
      },
    });
  }

  storedMessages(seeded: Seeded, chatId: string) {
    return getChatMessages(this.ctx.agentDb, {
      chatId,
      userId: seeded.user.id,
      organizationId: seeded.organization.id,
    }) as Promise<Array<{ id: string; role: string }> | null>;
  }
}
