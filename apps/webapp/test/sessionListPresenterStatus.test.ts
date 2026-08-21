// Integration guard for SessionListPresenter status + duration derivation.
//
// Drives the REAL SessionListPresenter.call() against a real Postgres (heteroPostgresTest).
// The ClickHouse session index is stubbed (orthogonal — it only orders ids) so each stub
// session's `currentRunId` points at a REAL run we seed in Postgres with a known status.
// The presenter's `findRuns` read + liveness check therefore run for real end-to-end, which
// is the wiring the pure unit test can't cover: does the presenter derive the filterable
// status correctly, compute `hasLiveRun` from the current run, and pass the freeze timestamp
// (`currentRunCompletedAt`) through?

import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ~/db.server: lazy proxies forwarding to per-test real-container clients (never mocks the DB
// itself). Run-ops split handles left undefined => runStore builds the single-DB passthrough store.
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const replicaHolder = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          if (value !== null && typeof value === "object") {
            return new Proxy(value, { get: (_d, method) => holder.client[prop][method] });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy(primaryHolder, "primaryHolder.client"),
    $replica: lazyProxy(replicaHolder, "replicaHolder.client"),
    runOpsNewPrismaClient: undefined,
    runOpsNewReplicaClient: undefined,
    runOpsLegacyPrisma: undefined,
    runOpsLegacyReplica: undefined,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

// Orthogonal peripherals.
const STUB_ENV = {
  id: "env_stub",
  type: "DEVELOPMENT" as const,
  slug: "dev",
  organizationId: "org_stub",
  projectId: "proj_stub",
  userId: undefined,
  branchName: null,
  git: null,
};

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findDisplayableEnvironment: async () => STUB_ENV,
}));

vi.mock("~/v3/models/workerDeployment.server", () => ({
  findCurrentWorkerFromEnvironment: async () => null,
}));

// The session list comes from ClickHouse via SessionsRepository — orthogonal to the run read.
// The stub returns controlled session rows whose currentRunId points at runs we seed for real.
const sessionListHolder = vi.hoisted(() => ({ sessions: [] as any[] }));
vi.mock("~/services/sessionsRepository/sessionsRepository.server", () => ({
  LEGACY_PLAYGROUND_TAG: "__playground__",
  SessionsRepository: class {
    constructor(_deps: any) {}
    async listSessions() {
      return {
        sessions: sessionListHolder.sessions,
        pagination: { nextCursor: null, previousCursor: null },
      };
    }
  },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
import { SessionListPresenter } from "~/presenters/v3/SessionListPresenter.server";

let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(p: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "my-agent",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: `trace_${p.runId}`,
      spanId: `span_${p.runId}`,
      runTags: [],
      queue: "task/my-agent",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Run is executing",
      runStatus: "EXECUTING",
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

// Seed a run, then mutate it to the target terminal/live status + completedAt for the test shape.
async function seedRun(
  prisma: PrismaClient,
  seed: { organization: { id: string }; project: { id: string }; environment: { id: string } },
  p: { suffix: string; status: TaskRunStatus; completedAt: Date | null }
) {
  const runId = `run_${p.suffix}`;
  const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  await writerStore.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_f_${p.suffix}`,
      organizationId: seed.organization.id,
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
    })
  );
  await prisma.taskRun.update({
    where: { id: runId },
    data: { status: p.status, completedAt: p.completedAt },
  });
  return runId;
}

function stubSession(p: {
  suffix: string;
  currentRunId: string | null;
  closedAt?: Date | null;
  expiresAt?: Date | null;
}) {
  return {
    id: `sess_${p.suffix}`,
    friendlyId: `session_${p.suffix}`,
    externalId: null,
    type: "chat.agent",
    taskIdentifier: "my-agent",
    isTest: false,
    tags: [],
    closedAt: p.closedAt ?? null,
    closedReason: null,
    expiresAt: p.expiresAt ?? null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    currentRunId: p.currentRunId,
  };
}

describe("SessionListPresenter status + duration derivation", () => {
  heteroPostgresTest(
    "keeps the filterable status and drives duration off run liveness",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `status_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const RUN_COMPLETED_AT = new Date("2024-01-01T00:10:00.000Z");
      const PAST = new Date("2020-01-01T00:00:00.000Z");

      // An open session whose only run has terminated — the reported bug. Status
      // stays ACTIVE (it is open), but it is not live so its duration freezes.
      const idleRunId = await seedRun(prisma, seed, {
        suffix: `idle_${suffix}`,
        status: "EXPIRED",
        completedAt: RUN_COMPLETED_AT,
      });
      // An open session with a genuinely live run.
      const activeRunId = await seedRun(prisma, seed, {
        suffix: `active_${suffix}`,
        status: "EXECUTING",
        completedAt: null,
      });
      // A closed session (still points at a live run — closed must win).
      const closedRunId = await seedRun(prisma, seed, {
        suffix: `closed_${suffix}`,
        status: "EXECUTING",
        completedAt: null,
      });

      sessionListHolder.sessions = [
        stubSession({ suffix: `idle_${suffix}`, currentRunId: idleRunId }),
        stubSession({ suffix: `active_${suffix}`, currentRunId: activeRunId }),
        stubSession({
          suffix: `closed_${suffix}`,
          currentRunId: closedRunId,
          closedAt: new Date("2024-01-02T00:00:00.000Z"),
        }),
        stubSession({ suffix: `expired_${suffix}`, currentRunId: null, expiresAt: PAST }),
        stubSession({ suffix: `neverran_${suffix}`, currentRunId: null }),
      ];

      primaryHolder.client = prisma;
      replicaHolder.client = prisma;

      const presenter = new SessionListPresenter(prisma as any, {} as any);
      const result = await presenter.call(seed.organization.id, seed.environment.id, {
        projectId: seed.project.id,
      });

      const byId = new Map(result.sessions.map((s) => [s.id, s] as const));

      // Open but not live: still ACTIVE (filterable), not live, and the duration
      // freezes at the terminated run's completion instead of climbing forever.
      const idle = byId.get(`sess_idle_${suffix}`)!;
      expect(idle.status).toBe("ACTIVE");
      expect(idle.hasLiveRun).toBe(false);
      expect(idle.currentRunCompletedAt).toBe(RUN_COMPLETED_AT.toISOString());

      // Open with a live run: ACTIVE and ticking.
      const active = byId.get(`sess_active_${suffix}`)!;
      expect(active.status).toBe("ACTIVE");
      expect(active.hasLiveRun).toBe(true);

      expect(byId.get(`sess_closed_${suffix}`)!.status).toBe("CLOSED");
      expect(byId.get(`sess_expired_${suffix}`)!.status).toBe("EXPIRED");

      // Open session that never ran: ACTIVE, not live, no freeze point (dash).
      const neverRan = byId.get(`sess_neverran_${suffix}`)!;
      expect(neverRan.status).toBe("ACTIVE");
      expect(neverRan.hasLiveRun).toBe(false);
      expect(neverRan.currentRunCompletedAt).toBeUndefined();
    }
  );
});
