// The skew protection thresholds (the environment's and each task's own) on a real Postgres: set,
// move and clear, the clear when a rollback goes below one, their history, and the migration from
// the staff floor flag.

import { describe, expect, vi } from "vitest";

// ChangeCurrentDeploymentService's side effects (task identifiers, declarative resources) use the
// module-level clients; point them at the test database.
const db = vi.hoisted(() => ({ client: undefined as any }));
vi.mock("~/db.server", async (importOriginal) => {
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        if (!db.client) throw new Error("db.client not set for this test");
        return db.client[prop];
      },
    }
  );
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    prisma: client,
    $replica: client,
    webhookPrisma: client,
    runOpsNewPrisma: client,
    runOpsLegacyPrisma: client,
  };
});

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { sessionVersionFloorFor } from "~/services/realtime/sessionVersionFloor.server";
import { NoopTaskMetadataCache } from "~/services/taskMetadataCache.server";
import { ChangeCurrentDeploymentService } from "~/v3/services/changeCurrentDeployment.server";
import {
  getSkewProtectionThreshold,
  getSkewProtectionThresholdChoices,
  getSkewProtectionPage,
  getSkewProtectionThresholdHistory,
  showsUpgradeSessions,
  skewProtectionThresholdApiResponse,
} from "~/presenters/v3/SkewProtectionThresholdPresenter.server";
import {
  action as thresholdApiAction,
  loader as thresholdApiLoader,
} from "~/routes/api.v1.deployments.skew-protection-threshold";
import { hashApiKey } from "~/utils/apiKeys";
import {
  apiKeyActorName,
  changeSkewProtectionThresholdFromDashboard,
  clearSkewProtectionThreshold,
  clearSkewProtectionThresholdsAbove,
  MAX_TASK_THRESHOLDS,
  setSkewProtectionThreshold,
} from "~/v3/services/skewProtectionThreshold.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const V1 = "20261108.1";
const V2 = "20261108.2";
const V10 = "20261108.10";

let seq = 0;

async function seed(prisma: PrismaClient, featureFlags: Record<string, unknown> = {}) {
  const suffix = `spt${seq++}${Math.random().toString(36).slice(2, 8)}`;
  const organization = await prisma.organization.create({
    data: { title: suffix, slug: suffix, featureFlags: featureFlags as never },
  });
  const project = await prisma.project.create({
    data: {
      name: suffix,
      slug: suffix,
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
      shortcode: `s_${suffix}`,
    },
  });
  return { organization, project, environment };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function deploy(
  prisma: PrismaClient,
  s: Seed,
  version: string,
  tasks: string[] = [],
  // Whether its agents (tasks named `*-agent`) are on an SDK that reports its settings.
  turnHandover = true
) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      sdkVersion: "4.9.0",
      friendlyId: `worker_${s.environment.id}_${version}`,
      contentHash: `hash_${version}`,
      version,
      metadata: {},
      projectId: s.project.id,
      runtimeEnvironmentId: s.environment.id,
    },
  });
  const deployment = await prisma.workerDeployment.create({
    data: {
      contentHash: `hash_${version}`,
      friendlyId: `deployment_${s.environment.id}_${version}`,
      shortCode: `dep_${s.environment.id}_${version}`,
      version,
      status: "DEPLOYED",
      workerId: worker.id,
      projectId: s.project.id,
      environmentId: s.environment.id,
    },
  });
  if (tasks.length > 0) {
    await prisma.backgroundWorkerTask.createMany({
      data: tasks.map((slug, index) => ({
        slug,
        friendlyId: `task_${s.environment.id}_${version}_${index}`,
        filePath: `src/trigger/${index}.ts`,
        workerId: worker.id,
        projectId: s.project.id,
        runtimeEnvironmentId: s.environment.id,
        ...(slug.endsWith("-agent")
          ? {
              triggerSource: "AGENT" as const,
              config: turnHandover
                ? { type: "ai-sdk-chat", turnHandover }
                : { type: "ai-sdk-chat" },
            }
          : { triggerSource: "STANDARD" as const }),
      })),
    });
  }
  return { worker, deployment };
}

// Makes `d` current through ChangeCurrentDeploymentService, which clears every threshold above it
// in the same transaction. `thresholdCleared` is the environment's; `tasksCleared` each task's. The version check is off so tests can move in either direction.
async function promote(
  prisma: PrismaClient,
  _s: Seed,
  d: Awaited<ReturnType<typeof deploy>>,
  actor: { direction: "promote" | "rollback"; userId?: string } = { direction: "promote" }
) {
  db.client = prisma;
  const result = await new ChangeCurrentDeploymentService(
    prisma,
    prisma,
    new NoopTaskMetadataCache()
  ).call(d.deployment, actor.direction, {
    disableVersionCheck: true,
    actor: actor.userId ? { userId: actor.userId } : undefined,
  });
  const cleared = result.skewProtectionThresholdsCleared;
  return { thresholdCleared: cleared?.environment, tasksCleared: cleared?.tasks ?? [] };
}

/** The stored column, as the append path gets it. Null when nothing is set. */
async function storedThresholds(prisma: PrismaClient, s: Seed) {
  const row = await prisma.runtimeEnvironment.findFirst({
    where: { id: s.environment.id },
    select: { skewProtectionThresholds: true },
  });
  return (row?.skewProtectionThresholds ?? null) as {
    environment?: Record<string, unknown>;
    tasks?: Record<string, Record<string, unknown>>;
  } | null;
}

/** The environment's own threshold as stored. */
async function thresholdOf(prisma: PrismaClient, s: Seed) {
  return (await storedThresholds(prisma, s))?.environment ?? null;
}

function setThreshold(prisma: PrismaClient, s: Seed, version: string, task?: string) {
  return setSkewProtectionThreshold(prisma, {
    environment: s.environment,
    version,
    task,
    setBy: { type: "api" },
    actor: { source: "api" },
  });
}

/** The floor an append would hold a session of `task` to. */
async function floorFor(prisma: PrismaClient, s: Seed, task: string) {
  return sessionVersionFloorFor(
    { type: "PRODUCTION", skewProtectionThresholds: await storedThresholds(prisma, s) },
    task
  );
}

describe("when a deployment becomes current", () => {
  postgresTest(
    "holding the threshold lock doesn't block inserts that reference the environment",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);

      let insert: Promise<unknown> | undefined;
      const outcome = await p.$transaction(async (tx) => {
        await clearSkewProtectionThresholdsAbove(tx, {
          environmentId: s.environment.id,
          version: V1,
        });
        // Another connection, while this transaction still holds the lock.
        insert = p.backgroundWorker.create({
          data: {
            friendlyId: `worker_${s.environment.id}_other`,
            contentHash: "hash_other",
            version: V2,
            metadata: {},
            projectId: s.project.id,
            runtimeEnvironmentId: s.environment.id,
          },
        });
        return Promise.race([
          insert.then(() => "inserted"),
          new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
        ]);
      });
      await insert;

      // Catches: a promote or a threshold change stalling a deploy's inserts (and the reverse)
      // through a FOR UPDATE lock on the environment row.
      expect(outcome).toBe("inserted");
    }
  );

  postgresTest("a promote alone sets nothing and records nothing", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);

    for (const version of [V1, V2, V10]) {
      expect(await promote(p, s, await deploy(p, s, version))).toEqual({
        thresholdCleared: undefined,
        tasksCleared: [],
      });
    }

    // Catches: a deploy moving sessions by itself. Only a threshold someone set does that.
    expect(await storedThresholds(p, s)).toBeNull();
    expect(
      await getSkewProtectionThresholdHistory(p, { environmentId: s.environment.id })
    ).toHaveLength(0);
  });

  postgresTest("a promote above the threshold leaves it where it was set", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    await promote(p, s, await deploy(p, s, V1));
    await promote(p, s, await deploy(p, s, V2));
    await setThreshold(p, s, V2);
    const before = await thresholdOf(p, s);

    expect((await promote(p, s, await deploy(p, s, V10))).thresholdCleared).toBeUndefined();

    // Catches: the threshold following each new deployment, which would move sessions on every
    // deploy. It is a one-time cutoff until someone raises it.
    expect(await thresholdOf(p, s)).toEqual(before);
    expect(
      await getSkewProtectionThresholdHistory(p, { environmentId: s.environment.id })
    ).toHaveLength(1);
  });

  postgresTest(
    "a rollback below the threshold clears it; one at or above keeps it",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      const v1 = await deploy(p, s, V1);
      const v2 = await deploy(p, s, V2);
      const v10 = await deploy(p, s, V10);
      await promote(p, s, v10);
      await setThreshold(p, s, V2);

      expect((await promote(p, s, v2)).thresholdCleared).toBeUndefined();
      expect(await thresholdOf(p, s)).toMatchObject({ version: V2 });

      expect((await promote(p, s, v1)).thresholdCleared).toEqual({ version: V2 });
      expect(await thresholdOf(p, s)).toBeNull();

      // Moving forward again doesn't bring it back.
      expect((await promote(p, s, v10)).thresholdCleared).toBeUndefined();
      expect(await thresholdOf(p, s)).toBeNull();
    }
  );
});

describe("skew protection threshold", () => {
  postgresTest("set, read, move, clear", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    await deploy(p, s, V1);
    const v2 = await deploy(p, s, V2);
    await promote(p, s, v2);

    expect(
      await setSkewProtectionThreshold(p, {
        environment: s.environment,
        version: V1,
        setBy: { type: "api" },
        actor: { source: "api" },
      })
    ).toEqual({ changed: true });
    expect(
      await setSkewProtectionThreshold(p, {
        environment: s.environment,
        version: V1,
        setBy: { type: "api" },
        actor: { source: "api" },
      })
    ).toEqual({ changed: false });

    const state = await getSkewProtectionThreshold(p, s.environment.id);
    expect(state).toMatchObject({
      currentVersion: V2,
      threshold: {
        version: V1,
        deploymentId: `deployment_${s.environment.id}_${V1}`,
        setBy: { type: "api" },
      },
    });

    await setSkewProtectionThreshold(p, {
      environment: s.environment,
      version: V2,
      setBy: { type: "api" },
      actor: { source: "api" },
    });
    expect((await getSkewProtectionThreshold(p, s.environment.id)).threshold?.version).toBe(V2);

    expect(await clearSkewProtectionThreshold(p, s.environment, { source: "api" })).toEqual({
      cleared: { version: V2 },
    });
    expect(await clearSkewProtectionThreshold(p, s.environment, { source: "api" })).toEqual({
      cleared: undefined,
    });
    // Catches: an empty object left behind, which every later request would load for nothing.
    expect(await storedThresholds(p, s)).toBeNull();
  });

  postgresTest(
    "rejects bad versions, unknown deployments, versions above current, dev",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      const v1 = await deploy(p, s, V1);
      await deploy(p, s, V2);

      const set = (version: string, type = "PRODUCTION") =>
        setSkewProtectionThreshold(p, {
          environment: { id: s.environment.id, type },
          version,
          setBy: { type: "api" },
          actor: { source: "api" },
        }).then(
          () => 200,
          (error: { status?: number }) => error.status
        );

      expect(await set(V1)).toBe(409); // no current deployment yet
      await promote(p, s, v1);
      expect(await set("latest")).toBe(400);
      expect(await set("20261108.x")).toBe(400);
      // Catches: a version of any length taking the threshold lock and coming back in the error.
      const long = "1.".repeat(500_000) + "1";
      const error = await setSkewProtectionThreshold(p, {
        environment: s.environment,
        version: long,
        setBy: { type: "api" },
        actor: { source: "api" },
      }).catch((e: Error & { status?: number }) => e);
      expect(error).toMatchObject({ status: 400 });
      expect((error as Error).message.length).toBeLessThan(100);
      expect(await set("1".repeat(65))).toBe(400);
      expect(await set(V1, "DEVELOPMENT")).toBe(400);
      expect(await set("20261108.9")).toBe(404);
      expect(await set(V2)).toBe(409);
      expect(await set(V1)).toBe(200);
      expect(await thresholdOf(p, s)).toMatchObject({ version: V1 });
    }
  );
});

describe("the Session upgrades page", () => {
  postgresTest(
    "lists each agent with its versionSkew and the threshold it follows",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      await promote(p, s, await deploy(p, s, V1, ["support-agent", "custom-agent", "inbox"]));
      const v2 = await deploy(p, s, V2, ["support-agent", "custom-agent", "inbox"]);
      await p.backgroundWorkerTask.updateMany({
        where: { workerId: v2.worker.id, slug: "support-agent" },
        data: { config: { type: "ai-sdk-chat", versionSkew: "hold" } },
      });
      await promote(p, s, v2);
      await setThreshold(p, s, V1);
      await setThreshold(p, s, V2, "support-agent");
      await setThreshold(p, s, V1, "inbox");

      const page = await getSkewProtectionPage(p, {
        environmentId: s.environment.id,
        userId: "user_sam",
      });

      expect(page.currentVersion).toBe(V2);
      expect(page.threshold).toMatchObject({ version: V1, byYou: false });
      expect(page.agents).toMatchObject([
        {
          task: "custom-agent",
          inCode: { type: "custom" },
          threshold: { version: V1, scope: "environment" },
        },
        // Catches: a threshold on a task that isn't a listed agent dropping off the page, where
        // nothing else could show or clear it.
        {
          task: "inbox",
          inCode: { type: "not-in-current" },
          threshold: { version: V1, scope: "task" },
        },
        {
          task: "support-agent",
          inCode: { type: "versionSkew", versionSkew: "hold" },
          threshold: { version: V2, scope: "task" },
        },
      ]);
      expect(page.changes).toHaveLength(3);

      // Catches: an agent's own threshold shown as the one in force when the environment's is
      // higher, while sessions move to the environment's.
      await setThreshold(p, s, V2);
      const higherEnvironment = await getSkewProtectionPage(p, {
        environmentId: s.environment.id,
        userId: "user_sam",
      });
      expect(higherEnvironment.agents.find((agent) => agent.task === "inbox")).toMatchObject({
        threshold: { version: V2, scope: "environment" },
        lowerOwnVersion: V1,
      });
    }
  );
});

describe("a threshold value this build can't read in full", () => {
  postgresTest(
    "the dashboard and a write read it as not set and warn; an append still gets the floor",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      const v1 = await deploy(p, s, V1);
      await promote(p, s, v1);
      const threshold = {
        version: V1,
        setAt: "2026-11-08T00:00:00.000Z",
        setBy: { type: "robot" },
      };
      await p.runtimeEnvironment.update({
        where: { id: s.environment.id },
        data: { skewProtectionThresholds: { environment: threshold } },
      });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const state = await getSkewProtectionThreshold(p, s.environment.id);
      expect(state.threshold).toBeNull();
      // Catches: an unreadable threshold value going unnoticed. Nothing else says which environment.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skew protection threshold doesn't match the schema"),
        expect.objectContaining({ environmentId: s.environment.id })
      );

      warn.mockClear();
      await setSkewProtectionThreshold(p, {
        environment: s.environment,
        version: V1,
        setBy: { type: "api" },
        actor: { source: "api" },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ environmentId: s.environment.id })
      );
      warn.mockRestore();

      expect(
        sessionVersionFloorFor(
          { type: "PRODUCTION", skewProtectionThresholds: { environment: threshold } },
          "my-agent"
        )
      ).toEqual({ minVersion: V1 });
    }
  );
});

describe("history", () => {
  postgresTest(
    "a promote to a version below the threshold is recorded as a rollback",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      const v1 = await deploy(p, s, V1);
      const v2 = await deploy(p, s, V2);
      await promote(p, s, v2);
      await setThreshold(p, s, V2);

      // What the API does with `allowRollbacks`: direction "promote", version check off.
      await promote(p, s, v1, { direction: "promote" });
      await promote(p, s, v2);

      const history = await getSkewProtectionThresholdHistory(p, {
        environmentId: s.environment.id,
      });
      // Catches: the history naming a promote for a threshold that going backwards cleared.
      expect(history.map(({ kind, version, source }) => ({ kind, version, source }))).toEqual([
        { kind: "cleared-by-rollback", version: V2, source: "rollback" },
        { kind: "set", version: V2, source: "api" },
      ]);
    }
  );

  // Catches: a threshold change that isn't recorded, or recorded with the wrong cause or actor.
  postgresTest("records every change with who and from where", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    const user = await p.user.create({
      data: {
        email: `history-${s.organization.slug}@example.com`,
        authenticationMethod: "MAGIC_LINK",
        displayName: "Maya Chen",
      },
    });
    await p.orgMember.create({
      data: { organizationId: s.organization.id, userId: user.id, role: "MEMBER" },
    });

    const v1 = await deploy(p, s, V1);
    const v2 = await deploy(p, s, V2);
    const v10 = await deploy(p, s, V10);

    await promote(p, s, v2);
    await changeSkewProtectionThresholdFromDashboard(p, {
      user: { id: user.id, displayName: "Maya Chen", name: null },
      projectId: s.project.id,
      environmentId: s.environment.id,
      change: { type: "set", version: V2 },
    });
    // Idempotent: the same version again writes no row.
    await setThreshold(p, s, V2);
    await promote(p, s, v10); // above the threshold: nothing to record
    await promote(p, s, v1, { direction: "rollback", userId: user.id }); // below the threshold

    const history = await getSkewProtectionThresholdHistory(p, {
      environmentId: s.environment.id,
    });
    expect(
      history.map(({ kind, version, currentVersion, source, actorName }) => ({
        kind,
        version,
        currentVersion,
        source,
        actorName,
      }))
    ).toEqual([
      {
        kind: "cleared-by-rollback",
        version: V2,
        currentVersion: V1,
        source: "rollback",
        actorName: "Maya Chen",
      },
      {
        kind: "set",
        version: V2,
        currentVersion: V2,
        source: "dashboard",
        actorName: "Maya Chen",
      },
    ]);

    await setThreshold(p, s, V1);
    await clearSkewProtectionThreshold(p, s.environment, { source: "api" });
    const [cleared, set] = await getSkewProtectionThresholdHistory(p, {
      environmentId: s.environment.id,
      take: 2,
    });
    expect(cleared).toMatchObject({ kind: "cleared", version: V1, source: "api" });
    expect(set).toMatchObject({ kind: "set", version: V1, source: "api" });
  });

  // Catches: a task's threshold recorded as the environment's, or an API change with no actor.
  postgresTest("records the task and the API key", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    await promote(p, s, await deploy(p, s, V1, ["support-agent"]));

    const keyToken = `tr_prod_sk_${"a".repeat(20)}wxyz`;
    await p.apiKey.create({
      data: {
        name: "CI deploys",
        keyHash: hashApiKey(keyToken),
        lastFour: "wxyz",
        runtimeEnvironmentId: s.environment.id,
      },
    });
    const ci = { source: "api", apiKeyName: await apiKeyActorName(p, keyToken) } as const;
    expect(ci.apiKeyName).toBe("CI deploys");
    expect(await apiKeyActorName(p, `tr_prod_sk_${"b".repeat(24)}`)).toBe("API key ...bbbb");
    expect(await apiKeyActorName(p, s.environment.apiKey)).toBe(
      `Secret key ...${s.environment.apiKey.slice(-4)}`
    );
    // Catches: a replica error failing the promote or threshold change it labels.
    const down = {
      apiKey: { findFirst: async () => Promise.reject(new Error("replica down")) },
    } as unknown as PrismaClient;
    expect(await apiKeyActorName(down, keyToken)).toBe("API key ...wxyz");

    await setSkewProtectionThreshold(p, {
      environment: s.environment,
      version: V1,
      task: "support-agent",
      setBy: { type: "api" },
      actor: ci,
    });
    await clearSkewProtectionThreshold(p, s.environment, ci, "support-agent");

    const history = await getSkewProtectionThresholdHistory(p, {
      environmentId: s.environment.id,
    });
    expect(
      history.map(({ task, kind, version, source, actorName }) => ({
        task,
        kind,
        version,
        source,
        actorName,
      }))
    ).toEqual([
      {
        task: "support-agent",
        kind: "cleared",
        version: V1,
        source: "api",
        actorName: "CI deploys",
      },
      { task: "support-agent", kind: "set", version: V1, source: "api", actorName: "CI deploys" },
    ]);
  });
});

describe("the Upgrade sessions button on a task's page", () => {
  postgresTest(
    "an agent always has it; a task that isn't an agent only once it has had a session",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      const shown = (taskIdentifier: string, onlyIfTaskHasSessions?: boolean) =>
        showsUpgradeSessions(p, {
          environment: s.environment,
          taskIdentifier,
          onlyIfTaskHasSessions,
        });
      const createSession = (taskIdentifier: string) =>
        p.session.create({
          data: {
            friendlyId: `session_${taskIdentifier}_${seq++}`,
            type: "chat.agent",
            projectId: s.project.id,
            runtimeEnvironmentId: s.environment.id,
            environmentType: "PRODUCTION",
            organizationId: s.organization.id,
            taskIdentifier,
            triggerConfig: { basePayload: {} } as never,
          },
        });

      // An agent's page is where its threshold is set, so it is there before any exists.
      expect(await shown("my-agent")).toBe(true);
      // Catches: every task's page offering Upgrade sessions it has no use for.
      expect(await shown("inbox", true)).toBe(false);
      await createSession("other-task");
      expect(await shown("inbox", true)).toBe(false);
      await createSession("inbox");
      expect(await shown("inbox", true)).toBe(true);
    }
  );

  postgresTest("is not shown in development", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);

    expect(
      await showsUpgradeSessions(p, {
        environment: { id: s.environment.id, type: "DEVELOPMENT" },
        taskIdentifier: "my-agent",
      })
    ).toBe(false);
  });
});

describe("a threshold for one task", () => {
  postgresTest(
    "is set, read and cleared beside the environment's, and only raises that task's floor",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      await deploy(p, s, V1, ["support-agent", "billing-agent"]);
      await deploy(p, s, V2, ["support-agent", "billing-agent"]);
      await promote(p, s, await deploy(p, s, V10, ["support-agent", "billing-agent"]));

      expect(await setThreshold(p, s, V2, "support-agent")).toEqual({ changed: true });
      expect(await setThreshold(p, s, V2, "support-agent")).toEqual({ changed: false });
      // Catches: one task's threshold moving every session in the environment.
      expect(await floorFor(p, s, "support-agent")).toEqual({
        minVersion: V2,
        taskIdentifier: "support-agent",
      });
      expect(await floorFor(p, s, "billing-agent")).toBeUndefined();

      await setThreshold(p, s, V1);
      await setThreshold(p, s, V10, "billing-agent");
      expect(await getSkewProtectionThreshold(p, s.environment.id)).toMatchObject({
        currentVersion: V10,
        threshold: { version: V1, deploymentId: `deployment_${s.environment.id}_${V1}` },
        tasks: [
          { task: "billing-agent", version: V10 },
          {
            task: "support-agent",
            version: V2,
            deploymentId: `deployment_${s.environment.id}_${V2}`,
            setBy: { type: "api" },
          },
        ],
      });

      // Catches: clearing one threshold taking the others with it.
      expect(
        await clearSkewProtectionThreshold(p, s.environment, { source: "api" }, "support-agent")
      ).toEqual({ cleared: { version: V2 } });
      expect(await floorFor(p, s, "support-agent")).toEqual({ minVersion: V1 });
      expect(await floorFor(p, s, "billing-agent")).toMatchObject({ minVersion: V10 });
      await clearSkewProtectionThreshold(p, s.environment, { source: "api" });
      expect(await floorFor(p, s, "support-agent")).toBeUndefined();
      expect(await floorFor(p, s, "billing-agent")).toMatchObject({ minVersion: V10 });
      await clearSkewProtectionThreshold(p, s.environment, { source: "api" }, "billing-agent");
      expect(await storedThresholds(p, s)).toBeNull();

      const history = await getSkewProtectionThresholdHistory(p, {
        environmentId: s.environment.id,
      });
      // Catches: a history that doesn't say which task a change was for.
      expect(history.map(({ kind, task, version }) => ({ kind, task, version }))).toEqual([
        { kind: "cleared", task: "billing-agent", version: V10 },
        { kind: "cleared", task: null, version: V1 },
        { kind: "cleared", task: "support-agent", version: V2 },
        { kind: "set", task: "billing-agent", version: V10 },
        { kind: "set", task: null, version: V1 },
        { kind: "set", task: "support-agent", version: V2 },
      ]);
    }
  );

  postgresTest(
    "needs the task in the current deployment, a sane id, and room under the cap",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      const many = Array.from({ length: MAX_TASK_THRESHOLDS + 1 }, (_, i) => `task-${i}`);
      await deploy(p, s, V1, ["retired-agent", ...many]);
      await promote(p, s, await deploy(p, s, V2, many));
      const set = (task: string, version = V1) =>
        setThreshold(p, s, version, task).then(
          () => 200,
          (error: { status?: number }) => error.status
        );

      // Catches: a threshold for a task the current deployment can't run, or for a typo.
      expect(await set("retired-agent")).toBe(404);
      expect(await set("no-such-task")).toBe(404);
      expect(await set("")).toBe(400);
      expect(await set("x".repeat(257))).toBe(400);
      expect(await set("task-0", "20261108.9")).toBe(404);
      expect(await storedThresholds(p, s)).toBeNull();

      for (const task of many.slice(0, MAX_TASK_THRESHOLDS)) expect(await set(task)).toBe(200);
      // Catches: the value every authenticated request loads growing without bound.
      expect(await set(many[MAX_TASK_THRESHOLDS])).toBe(409);
      // One that already has a threshold can still be moved.
      expect(await set("task-0", V2)).toBe(200);
    }
  );

  postgresTest(
    "a rollback clears each threshold above the new current version, with a history row each",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const s = await seed(p);
      const tasks = ["support-agent", "billing-agent", "search-agent"];
      const v1 = await deploy(p, s, V1, tasks);
      const v2 = await deploy(p, s, V2, tasks);
      await promote(p, s, await deploy(p, s, V10, tasks));
      await setThreshold(p, s, V2);
      await setThreshold(p, s, V10, "support-agent");
      await setThreshold(p, s, V2, "billing-agent");
      await setThreshold(p, s, V1, "search-agent");

      // To V2: only the threshold above it goes.
      expect(await promote(p, s, v2)).toEqual({
        thresholdCleared: undefined,
        tasksCleared: [{ task: "support-agent", version: V10 }],
      });
      expect(await floorFor(p, s, "support-agent")).toEqual({ minVersion: V2 });

      // To V1: the environment's and billing-agent's go; search-agent's, at V1, stays.
      expect(await promote(p, s, v1, { direction: "rollback" })).toEqual({
        thresholdCleared: { version: V2 },
        tasksCleared: [{ task: "billing-agent", version: V2 }],
      });
      // Catches: a task threshold left above the current deployment, which holds that task's
      // sessions to a version nothing can move them to.
      expect(await storedThresholds(p, s)).toMatchObject({ tasks: { "search-agent": {} } });
      expect(await thresholdOf(p, s)).toBeNull();
      expect(await floorFor(p, s, "billing-agent")).toBeUndefined();
      expect(await floorFor(p, s, "search-agent")).toMatchObject({ minVersion: V1 });

      const history = await getSkewProtectionThresholdHistory(p, {
        environmentId: s.environment.id,
      });
      expect(
        history
          .filter((change) => change.kind === "cleared-by-rollback")
          .map(({ task, version, currentVersion }) => ({ task, version, currentVersion }))
      ).toEqual(
        expect.arrayContaining([
          { task: "support-agent", version: V10, currentVersion: V2 },
          { task: null, version: V2, currentVersion: V1 },
          { task: "billing-agent", version: V2, currentVersion: V1 },
        ])
      );
    }
  );

  postgresTest("a task id is data, whatever it is called", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    const names = ["__proto__", "constructor", 'it\'s "quoted" {a,b}', "support-agent"];
    await deploy(p, s, V1, names);
    await promote(p, s, await deploy(p, s, V2, names));

    for (const name of names.slice(0, 3)) {
      expect(await setThreshold(p, s, V1, name)).toEqual({ changed: true });
    }

    // Catches: a task id reaching the stored object as a prototype or a path, or SQL.
    const state = await getSkewProtectionThreshold(p, s.environment.id);
    expect(state.tasks.map(({ task, version }) => ({ task, version }))).toEqual(
      names
        .slice(0, 3)
        .sort()
        .map((task) => ({ task, version: V1 }))
    );
    for (const name of names.slice(0, 3)) {
      expect(await floorFor(p, s, name)).toEqual({ minVersion: V1, taskIdentifier: name });
    }
    expect(await floorFor(p, s, "support-agent")).toBeUndefined();
    expect(await floorFor(p, s, "toString")).toBeUndefined();

    for (const name of names.slice(0, 3)) {
      expect(await clearSkewProtectionThreshold(p, s.environment, { source: "api" }, name)).toEqual(
        { cleared: { version: V1 } }
      );
    }
    expect(await storedThresholds(p, s)).toBeNull();
  });

  postgresTest("the set dialogs offer what can be set", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    await deploy(p, s, V1, ["support-agent", "inbox", "retired-agent"]);
    await promote(p, s, await deploy(p, s, V2, ["support-agent", "inbox", "plain-task"]));
    await deploy(p, s, V10, ["support-agent", "inbox"]);
    await p.session.create({
      data: {
        friendlyId: `session_inbox_${seq++}`,
        type: "raw",
        projectId: s.project.id,
        runtimeEnvironmentId: s.environment.id,
        environmentType: "PRODUCTION",
        organizationId: s.organization.id,
        taskIdentifier: "inbox",
        triggerConfig: { basePayload: {} } as never,
      },
    });

    // Catches: the agent page offering a version above current (a 409) or one without the task.
    expect(
      await getSkewProtectionThresholdChoices(p, {
        environmentId: s.environment.id,
        userId: "user_sam",
        task: "support-agent",
      })
    ).toEqual({ currentVersion: V2, versions: [V2, V1], threshold: null });
    expect(
      await getSkewProtectionThresholdChoices(p, {
        environmentId: s.environment.id,
        userId: "user_sam",
        task: "plain-task",
      })
    ).toEqual({ currentVersion: V2, versions: [V2], threshold: null });

    // Catches: the Deployments dialog offering a version above current.
    expect(
      (
        await getSkewProtectionThresholdChoices(p, {
          environmentId: s.environment.id,
          userId: "user_sam",
        })
      ).versions
    ).toEqual([V2, V1]);

    // Catches: the Threshold row not saying who set it, or an agent page not showing the
    // environment's threshold that covers the agent.
    await setSkewProtectionThreshold(p, {
      environment: s.environment,
      version: V1,
      setBy: { type: "user", id: "user_sam", name: "Sam" },
      actor: { source: "api" },
    });
    const agent = await getSkewProtectionThresholdChoices(p, {
      environmentId: s.environment.id,
      userId: "user_sam",
      task: "support-agent",
    });
    expect(agent.threshold).toMatchObject({ version: V1, scope: "environment", byYou: true });
    const other = await getSkewProtectionThresholdChoices(p, {
      environmentId: s.environment.id,
      userId: "someone-else",
    });
    expect(other.threshold).toMatchObject({ scope: "environment", byYou: false });
  });

  // Catches: a rollback below the 100 newest deployments leaving the picker empty, since every
  // version read was above current.
  postgresTest("the dialogs still offer versions after a deep rollback", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    await promote(p, s, await deploy(p, s, V1, ["support-agent"]));
    const later = new Date(Date.now() + 60_000);
    await p.workerDeployment.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        contentHash: `hash_newer_${i}`,
        friendlyId: `deployment_${s.environment.id}_newer_${i}`,
        shortCode: `dep_${s.environment.id}_newer_${i}`,
        version: `20261109.${i + 1}`,
        status: "DEPLOYED" as const,
        projectId: s.project.id,
        environmentId: s.environment.id,
        createdAt: new Date(later.getTime() + i),
      })),
    });

    for (const task of [undefined, "support-agent"]) {
      const choices = await getSkewProtectionThresholdChoices(p, {
        environmentId: s.environment.id,
        userId: "user_sam",
        task,
      });
      expect(choices.versions).toEqual([V1]);
    }
  });

  postgresTest("the dialog's In code row shows a chat.agent's versionSkew", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    const versionSkew = async (task: string) => {
      const choices = await getSkewProtectionThresholdChoices(p, {
        environmentId: s.environment.id,
        userId: "user_sam",
        task,
      });
      return "versionSkew" in choices ? choices.versionSkew : "no row";
    };
    const configure = (workerId: string, slug: string, config: object) =>
      p.backgroundWorkerTask.updateMany({ where: { workerId, slug }, data: { config } });

    // An SDK from before agents reported it: "not reported".
    await promote(p, s, await deploy(p, s, V1, ["support-agent"], false));
    expect(await versionSkew("support-agent")).toBeNull();

    const v2 = await deploy(p, s, V2, ["support-agent", "custom-agent", "inbox"]);
    await configure(v2.worker.id, "support-agent", {
      type: "ai-sdk-chat",
      versionSkew: "hold",
    });
    await configure(v2.worker.id, "custom-agent", { type: "ai-sdk-chat", turnHandover: true });
    await promote(p, s, v2);
    expect(await versionSkew("support-agent")).toBe("hold");
    // Catches: a chat.customAgent shown as "Not reported by this version's SDK".
    expect(await versionSkew("custom-agent")).toBe("no row");
    expect(await versionSkew("inbox")).toBe("no row");
  });
});

describe("skew protection threshold API", () => {
  const call = (
    s: Seed,
    method: "GET" | "PUT" | "DELETE",
    options: { body?: unknown; query?: string } = {}
  ) => {
    const args = {
      request: new Request(
        `http://localhost/api/v1/deployments/skew-protection-threshold${options.query ?? ""}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${s.environment.apiKey}`,
            "Content-Type": "application/json",
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        }
      ),
      params: {},
      context: {},
    } as never;
    return method === "GET" ? thresholdApiLoader(args) : thresholdApiAction(args);
  };

  postgresTest("sets, lists and clears a threshold for one task", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    db.client = p;
    await deploy(p, s, V1, ["support-agent"]);
    await promote(p, s, await deploy(p, s, V2, ["support-agent"]));

    // Catches: a typo in `task` silently becoming a threshold for every task, or for nothing.
    const unknown = await call(s, "PUT", { body: { version: V1, task: "suport-agent" } });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toContain("suport-agent");
    expect((await call(s, "PUT", { body: { version: V1, task: "" } })).status).toBe(400);
    expect((await call(s, "PUT", { body: { version: V1, task: 5 } })).status).toBe(400);
    expect((await call(s, "DELETE", { query: `?task=${"x".repeat(300)}` })).status).toBe(400);
    // Catches: a NUL in a task id reaching Postgres as a parameter, which answers with a 500.
    expect(
      (await call(s, "PUT", { body: { version: V1, task: "support\u0000agent" } })).status
    ).toBe(400);
    expect((await call(s, "DELETE", { query: "?task=support%00agent" })).status).toBe(400);
    expect(await storedThresholds(p, s)).toBeNull();

    const set = await call(s, "PUT", { body: { version: V1, task: "support-agent" } });
    expect(set.status).toBe(200);
    const listed = { "support-agent": { version: V1, setBy: { type: "api" } } };
    expect(await set.json()).toMatchObject({ currentVersion: V2, threshold: null, tasks: listed });
    await call(s, "PUT", { body: { version: V2 } });
    expect(await (await call(s, "GET")).json()).toMatchObject({
      threshold: { version: V2 },
      tasks: listed,
    });

    // Catches: DELETE with `task` clearing the environment's threshold, or the reverse.
    const cleared = await call(s, "DELETE", { query: "?task=support-agent" });
    expect(await cleared.json()).toMatchObject({ threshold: { version: V2 }, tasks: {} });
    expect(await (await call(s, "DELETE")).json()).toMatchObject({ threshold: null, tasks: {} });

    // Catches: an API change in the history with no actor.
    const [latest] = await getSkewProtectionThresholdHistory(p, {
      environmentId: s.environment.id,
      take: 1,
    });
    expect(latest).toMatchObject({
      kind: "cleared",
      source: "api",
      actorName: `Secret key ...${s.environment.apiKey.slice(-4)}`,
    });
  });

  // Catches: a public key (shipped to browsers) reading or changing the threshold.
  postgresTest("refuses a public key", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    db.client = p;
    const response = await thresholdApiAction({
      request: new Request("http://localhost/api/v1/deployments/skew-protection-threshold", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${s.environment.pkApiKey}` },
      }),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(401);
  });

  // Catches: a megabyte version taking the threshold lock and coming back whole in the error body.
  postgresTest("a long version is a 400 with a short body", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    db.client = p;
    const response = await thresholdApiAction({
      request: new Request("http://localhost/api/v1/deployments/skew-protection-threshold", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${s.environment.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: "1.".repeat(500_000) + "1" }),
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect((await response.text()).length).toBeLessThan(200);
  });
});

describe("skew protection threshold from the Deployments page", () => {
  // Catches: the dashboard action trusting the posted environment id, so a member of one
  // organization could set or clear the threshold of another organization's environment.
  postgresTest("only reaches environments in the user's organizations", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const mine = await seed(p);
    const theirs = await seed(p);
    for (const s of [mine, theirs]) {
      await promote(p, s, await deploy(p, s, V1));
    }
    const user = await p.user.create({
      data: {
        email: `skew-${mine.organization.slug}@example.com`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
    await p.orgMember.create({
      data: { organizationId: mine.organization.id, userId: user.id, role: "MEMBER" },
    });
    const actor = { id: user.id, displayName: "Maya", name: null };

    await expect(
      changeSkewProtectionThresholdFromDashboard(p, {
        user: actor,
        projectId: theirs.project.id,
        environmentId: theirs.environment.id,
        change: { type: "set", version: V1 },
      })
    ).rejects.toMatchObject({ status: 404 });
    // Its own project id with the other organization's environment id.
    await expect(
      changeSkewProtectionThresholdFromDashboard(p, {
        user: actor,
        projectId: mine.project.id,
        environmentId: theirs.environment.id,
        change: { type: "set", version: V1 },
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(await thresholdOf(p, theirs)).toBeNull();

    await changeSkewProtectionThresholdFromDashboard(p, {
      user: actor,
      projectId: mine.project.id,
      environmentId: mine.environment.id,
      change: { type: "set", version: V1 },
    });
    expect(await thresholdOf(p, mine)).toMatchObject({
      version: V1,
      setBy: { type: "user", id: user.id, name: "Maya" },
    });
    // Catches: the API returning the name whenever one is stored.
    expect(
      skewProtectionThresholdApiResponse(await getSkewProtectionThreshold(p, mine.environment.id))
        .threshold?.setBy
    ).toEqual({ type: "user" });

    await changeSkewProtectionThresholdFromDashboard(p, {
      user: actor,
      projectId: mine.project.id,
      environmentId: mine.environment.id,
      change: { type: "clear" },
    });
    expect(await thresholdOf(p, mine)).toBeNull();
  });

  // Catches: the API's `setBy` carrying the user's id or name, or their email stored and shown as
  // the name when they have no display name or name.
  postgresTest("records no email and returns no person for who set it", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const s = await seed(p);
    await promote(p, s, await deploy(p, s, V1));
    const email = `nameless-${s.organization.slug}@example.com`;
    const user = await p.user.create({ data: { email, authenticationMethod: "MAGIC_LINK" } });
    await p.orgMember.create({
      data: { organizationId: s.organization.id, userId: user.id, role: "MEMBER" },
    });

    await changeSkewProtectionThresholdFromDashboard(p, {
      user: { id: user.id, displayName: user.displayName, name: user.name },
      projectId: s.project.id,
      environmentId: s.environment.id,
      change: { type: "set", version: V1 },
    });

    expect(JSON.stringify(await thresholdOf(p, s))).not.toContain(email);
    const state = await getSkewProtectionThreshold(p, s.environment.id);
    expect(state.threshold?.setBy).toEqual({ type: "user" });
    expect(JSON.stringify(state)).not.toContain(user.id);

    const [set] = await getSkewProtectionThresholdHistory(p, { environmentId: s.environment.id });
    expect(set).toMatchObject({ kind: "set", actorName: "a team member" });
  });
});
