// Version-skew pinning for chat sessions, driven through the real `ensureRunForSession` /
// `swapSessionRun` against a real Postgres: the stored pin is forwarded to every run the session
// schedules, and `reason: "upgrade"` drops it (or replaces it) AND persists that on the row.

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const storeHolder = vi.hoisted(() => ({ store: undefined as any }));

vi.mock("~/services/realtime/v1StreamsGlobal.server", () => ({
  determineRealtimeStreamsVersion: () => "v2",
}));

const triggerState = vi.hoisted(() => ({
  calls: [] as Array<{ taskIdentifier: string; body: any; options: any }>,
  result: { run: { id: "", friendlyId: "", status: "PENDING" } } as {
    run: { id: string; friendlyId: string; status: string };
  },
}));

vi.mock("~/db.server", () => {
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
    $replica: lazyProxy(primaryHolder, "primaryHolder.client"),
  };
});

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = storeHolder.store as Record<string | symbol, unknown>;
        if (!store) throw new Error("test bug: storeHolder.store not set before caller ran");
        const value = store[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(store)
          : value;
      },
    }
  ),
}));

vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("~/v3/services/triggerTask.server", () => ({
  TriggerTaskService: class {
    async call(taskIdentifier: string, _environment: any, body: any, options: any) {
      triggerState.calls.push({ taskIdentifier, body, options });
      return triggerState.result;
    }
  },
}));

vi.mock("~/v3/services/cancelTaskRun.server", () => ({
  CancelTaskRunService: class {
    async call() {}
  },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ensureRunForSession, swapSessionRun } from "~/services/realtime/sessionRunManager.server";

let seq = 0;

const cuidRunId = (suffix: string) => `run_${suffix.padEnd(24, "x").slice(0, 24)}`;

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
      type: "PRODUCTION",
      slug: "prod",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
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
  status?: CreateRunInput["data"]["status"];
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: p.status ?? "PENDING",
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "my-chat",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: [],
      queue: "task/my-chat",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: p.status ?? "PENDING",
      environmentId: p.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

function environmentFor(seed: Awaited<ReturnType<typeof seedTenant>>) {
  return {
    id: seed.environment.id,
    organization: { streamBasinName: null },
  } as unknown as AuthenticatedEnvironment;
}

async function setup(prisma: PrismaClient, suffix: string) {
  const seed = await seedTenant(prisma, suffix);
  const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  primaryHolder.client = prisma;
  storeHolder.store = writerStore;
  triggerState.calls.length = 0;
  return { seed, writerStore };
}

/** The trigger options the caller built from the session's config on the last recorded call. */
function optionsOnLastTrigger(): Record<string, unknown> {
  return triggerState.calls.at(-1)?.body?.options ?? {};
}

function pinOnLastTrigger(): unknown {
  return optionsOnLastTrigger().externalDeploymentId;
}

describe("session runs — external deployment id", () => {
  postgresTest("an initial run forwards the session's stored pin", async ({ prisma }) => {
    const suffix = `pin_initial_${seq++}`;
    const { seed } = await setup(prisma as unknown as PrismaClient, suffix);
    triggerState.result = {
      run: { id: cuidRunId(`i${seq}`), friendlyId: `run_${suffix}`, status: "PENDING" },
    };

    const session = await prisma.session.create({
      data: {
        friendlyId: `session_${suffix}`,
        type: "chat.agent",
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
        environmentType: "PRODUCTION",
        organizationId: seed.organization.id,
        taskIdentifier: "my-chat",
        triggerConfig: { basePayload: {}, externalDeploymentId: "commit-abc" },
        currentRunVersion: 0,
      },
    });

    const result = await ensureRunForSession({
      session,
      environment: environmentFor(seed),
      reason: "initial",
    });

    expect(result.triggered).toBe(true);
    expect(pinOnLastTrigger()).toBe("commit-abc");
  });

  postgresTest(
    "a continuation re-applies the stored pin — the conversation stays on its deployment",
    async ({ prisma }) => {
      const suffix = `pin_cont_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);

      // A dead prior run, so `ensureRunForSession` takes the continuation branch.
      const deadRunId = cuidRunId(`d${seq}`);
      await writerStore.createRun(
        buildCreateRunInput({
          runId: deadRunId,
          friendlyId: `run_${suffix}_dead`,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "COMPLETED_SUCCESSFULLY",
        })
      );
      triggerState.result = {
        run: { id: cuidRunId(`c${seq}`), friendlyId: `run_${suffix}_new`, status: "PENDING" },
      };

      const session = await prisma.session.create({
        data: {
          friendlyId: `session_${suffix}`,
          type: "chat.agent",
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "PRODUCTION",
          organizationId: seed.organization.id,
          taskIdentifier: "my-chat",
          triggerConfig: { basePayload: {}, externalDeploymentId: "commit-abc" },
          currentRunId: deadRunId,
          currentRunVersion: 0,
        },
      });

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed),
        reason: "continuation",
      });

      expect(result.triggered).toBe(true);
      expect(pinOnLastTrigger()).toBe("commit-abc");
    }
  );

  postgresTest("reports pendingVersion when the triggered run parks", async ({ prisma }) => {
    const suffix = `pin_parked_${seq++}`;
    const { seed } = await setup(prisma as unknown as PrismaClient, suffix);
    triggerState.result = {
      run: {
        id: cuidRunId(`p${seq}`),
        friendlyId: `run_${suffix}`,
        status: "PENDING_VERSION",
      },
    };

    const session = await prisma.session.create({
      data: {
        friendlyId: `session_${suffix}`,
        type: "chat.agent",
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
        environmentType: "PRODUCTION",
        organizationId: seed.organization.id,
        taskIdentifier: "my-chat",
        triggerConfig: { basePayload: {}, externalDeploymentId: "not-deployed-yet" },
        currentRunVersion: 0,
      },
    });

    const result = await ensureRunForSession({
      session,
      environment: environmentFor(seed),
      reason: "initial",
    });

    expect(result.pendingVersion).toBe(true);
  });

  postgresTest(
    "reuses a parked run rather than triggering a second one — appends queue instead",
    async ({ prisma }) => {
      const suffix = `pin_reuse_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);

      // PENDING_VERSION is non-final, so the probe must treat the parked run as alive.
      const parkedRunId = cuidRunId(`r${seq}`);
      await writerStore.createRun(
        buildCreateRunInput({
          runId: parkedRunId,
          friendlyId: `run_${suffix}_parked`,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          status: "PENDING_VERSION",
        })
      );

      const session = await prisma.session.create({
        data: {
          friendlyId: `session_${suffix}`,
          type: "chat.agent",
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "PRODUCTION",
          organizationId: seed.organization.id,
          taskIdentifier: "my-chat",
          triggerConfig: { basePayload: {}, externalDeploymentId: "not-deployed-yet" },
          currentRunId: parkedRunId,
          currentRunVersion: 0,
        },
      });

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed),
        reason: "continuation",
      });

      expect(result).toEqual({ runId: parkedRunId, triggered: false, pendingVersion: true });
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  postgresTest(
    "an upgrade drops the pin and persists that, so the next continuation cannot bounce back",
    async ({ prisma }) => {
      const suffix = `pin_upgrade_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);

      const callingRunId = cuidRunId(`u${seq}`);
      await writerStore.createRun(
        buildCreateRunInput({
          runId: callingRunId,
          friendlyId: `run_${suffix}_calling`,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );
      triggerState.result = {
        run: { id: cuidRunId(`u2${seq}`), friendlyId: `run_${suffix}_new`, status: "PENDING" },
      };

      const session = await prisma.session.create({
        data: {
          friendlyId: `session_${suffix}`,
          type: "chat.agent",
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "PRODUCTION",
          organizationId: seed.organization.id,
          taskIdentifier: "my-chat",
          triggerConfig: {
            basePayload: {},
            externalDeploymentId: "commit-old",
            lockToVersion: "20260807.1",
          },
          currentRunId: callingRunId,
          currentRunVersion: 0,
        },
      });

      const result = await swapSessionRun({
        session,
        callingRunId,
        environment: environmentFor(seed),
        reason: "upgrade",
      });

      expect(result.swapped).toBe(true);
      expect(pinOnLastTrigger()).toBeUndefined();
      // `lockToVersion` is an explicit customer pin with different intent — never cleared.
      expect(optionsOnLastTrigger().lockToVersion).toBe("20260807.1");

      const stored = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      expect(stored.triggerConfig).toMatchObject({ lockToVersion: "20260807.1" });
      expect(stored.triggerConfig).not.toHaveProperty("externalDeploymentId");
    }
  );

  postgresTest(
    "an upgrade with an explicit target re-pins and persists the new id",
    async ({ prisma }) => {
      const suffix = `pin_repin_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);

      const callingRunId = cuidRunId(`t${seq}`);
      await writerStore.createRun(
        buildCreateRunInput({
          runId: callingRunId,
          friendlyId: `run_${suffix}_calling`,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );
      triggerState.result = {
        run: { id: cuidRunId(`t2${seq}`), friendlyId: `run_${suffix}_new`, status: "PENDING" },
      };

      const session = await prisma.session.create({
        data: {
          friendlyId: `session_${suffix}`,
          type: "chat.agent",
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          environmentType: "PRODUCTION",
          organizationId: seed.organization.id,
          taskIdentifier: "my-chat",
          triggerConfig: { basePayload: {}, externalDeploymentId: "commit-old" },
          currentRunId: callingRunId,
          currentRunVersion: 0,
        },
      });

      const result = await swapSessionRun({
        session,
        callingRunId,
        environment: environmentFor(seed),
        reason: "upgrade",
        externalDeploymentId: "commit-new",
      });

      expect(result.swapped).toBe(true);
      expect(pinOnLastTrigger()).toBe("commit-new");

      const stored = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      expect(stored.triggerConfig).toMatchObject({ externalDeploymentId: "commit-new" });
    }
  );

  postgresTest("a preempted upgrade leaves the stored config untouched", async ({ prisma }) => {
    const suffix = `pin_preempt_${seq++}`;
    const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);

    const callingRunId = cuidRunId(`x${seq}`);
    const winnerRunId = cuidRunId(`w${seq}`);
    for (const [runId, name] of [
      [callingRunId, "calling"],
      [winnerRunId, "winner"],
    ] as const) {
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: `run_${suffix}_${name}`,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );
    }
    triggerState.result = {
      run: { id: cuidRunId(`x2${seq}`), friendlyId: `run_${suffix}_new`, status: "PENDING" },
    };

    // `currentRunId` is already the winner, so the claim (keyed on callingRunId) cannot match.
    const session = await prisma.session.create({
      data: {
        friendlyId: `session_${suffix}`,
        type: "chat.agent",
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
        environmentType: "PRODUCTION",
        organizationId: seed.organization.id,
        taskIdentifier: "my-chat",
        triggerConfig: { basePayload: {}, externalDeploymentId: "commit-old" },
        currentRunId: winnerRunId,
        currentRunVersion: 0,
      },
    });

    const result = await swapSessionRun({
      session: { ...session, currentRunId: callingRunId },
      callingRunId,
      environment: environmentFor(seed),
      reason: "upgrade",
    });

    expect(result.swapped).toBe(false);

    const stored = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
    expect(stored.triggerConfig).toMatchObject({ externalDeploymentId: "commit-old" });
  });
});
