import { beforeEach, describe, expect, it, vi } from "vitest";
import * as deploymentCancel from "~/routes/resources.$projectId.deployments.$deploymentShortCode.cancel";
import * as deploymentPromote from "~/routes/resources.$projectId.deployments.$deploymentShortCode.promote";
import * as deploymentRedeploy from "~/routes/resources.$projectId.deployments.$deploymentShortCode.redeploy";
import * as deploymentRollback from "~/routes/resources.$projectId.deployments.$deploymentShortCode.rollback";
import * as regenerateApiKey from "~/routes/resources.environments.$environmentId.regenerate-api-key";
import * as runCancel from "~/routes/resources.taskruns.$runParam.cancel";
import * as runReplay from "~/routes/resources.taskruns.$runParam.replay";

vi.setConfig({ testTimeout: 30_000 });

type RouteOptions = {
  params: { parse: (params: unknown) => unknown };
  context: (params: unknown) => Promise<unknown>;
  authorization: unknown;
};

const STATE = vi.hoisted(() => ({
  // friendlyId -> environment id, per run store read
  replicaRuns: {} as Record<string, string>,
  primaryRuns: {} as Record<string, string>,
  bufferedRuns: {} as Record<string, { envId: string; orgId: string }>,
  // environment id -> scope, as the cached control-plane resolver and the primary see them
  resolvedEnvironments: {} as Record<string, { organizationId: string; projectId: string }>,
  primaryEnvironments: {} as Record<string, { organizationId: string; projectId: string }>,
}));

vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-secret", NODE_ENV: "test" } }));
// Keep the options each route hands the builder, so the test can read its auth scope.
vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (options: RouteOptions) => Object.assign(async () => null, { options }),
  dashboardLoader: (options: RouteOptions) => Object.assign(async () => null, { options }),
}));
vi.mock("~/db.server", () => {
  const primary = {
    primary: true,
    runtimeEnvironment: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        STATE.primaryEnvironments[where.id] ?? null,
    },
  };
  return {
    prisma: primary,
    $replica: {
      project: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === "proj_1" ? { organizationId: "org_1" } : null,
      },
      runtimeEnvironment: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === "env_1" ? { organizationId: "org_1", projectId: "proj_1" } : null,
      },
    },
  };
});
vi.mock("~/v3/runStore.server", () => ({
  runStore: {
    findRun: async (
      where: { friendlyId: string },
      _options: unknown,
      client?: { primary?: boolean }
    ) => {
      const runs = client?.primary ? STATE.primaryRuns : STATE.replicaRuns;
      const envId = runs[where.friendlyId];
      return envId ? { runtimeEnvironmentId: envId } : null;
    },
  },
}));
vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: {
    resolveEnv: async (id: string) =>
      STATE.resolvedEnvironments[id] ? { id, ...STATE.resolvedEnvironments[id] } : null,
  },
}));
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => ({
    getEntry: async (runId: string) => STATE.bufferedRuns[runId] ?? null,
  }),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/models/message.server", () => ({
  redirectWithErrorMessage: vi.fn(),
  redirectWithSuccessMessage: vi.fn(),
  jsonWithErrorMessage: vi.fn(),
  jsonWithSuccessMessage: vi.fn(),
}));
vi.mock("~/v3/services/changeCurrentDeployment.server", () => ({
  ChangeCurrentDeploymentService: class {},
}));
vi.mock("~/v3/services/deployment.server", () => ({ DeploymentService: class {} }));
vi.mock("~/v3/services/redeployDeployment.server", () => ({
  RedeployDeploymentService: class {},
}));
vi.mock("~/v3/rollbackMissingTasks.server", () => ({
  findRollbackTarget: vi.fn(),
  findTasksMissingFromTarget: vi.fn(),
}));
vi.mock("~/v3/services/cancelTaskRun.server", () => ({ CancelTaskRunService: class {} }));
vi.mock("~/v3/services/replayTaskRun.server", () => ({ ReplayTaskRunService: class {} }));
vi.mock("~/services/session.server", () => ({ requireUser: vi.fn() }));
vi.mock("~/models/api-key.server", () => ({ regenerateApiKey: vi.fn() }));
vi.mock("~/models/vercelIntegration.server", () => ({ VercelIntegrationRepository: class {} }));

type Handler = { options: RouteOptions };

const routes: Record<string, Handler> = {
  "deployment promote action": deploymentPromote.action as unknown as Handler,
  "deployment cancel action": deploymentCancel.action as unknown as Handler,
  "deployment rollback loader": deploymentRollback.loader as unknown as Handler,
  "deployment rollback action": deploymentRollback.action as unknown as Handler,
  "deployment redeploy action": deploymentRedeploy.action as unknown as Handler,
  "run cancel action": runCancel.action as unknown as Handler,
  "run replay action": runReplay.action as unknown as Handler,
  "regenerate API key action": regenerateApiKey.action as unknown as Handler,
};

async function scopeOf(name: string, params: Record<string, string>) {
  const { options } = routes[name];
  return options.context(options.params.parse(params));
}

beforeEach(() => {
  STATE.replicaRuns = {};
  STATE.primaryRuns = {};
  STATE.bufferedRuns = {};
  STATE.resolvedEnvironments = { env_1: { organizationId: "org_1", projectId: "proj_1" } };
  STATE.primaryEnvironments = { env_1: { organizationId: "org_1", projectId: "proj_1" } };
});

const projectScope = { organizationId: "org_1", projectId: "proj_1" };

describe("deployment routes", () => {
  const names = [
    "deployment promote action",
    "deployment cancel action",
    "deployment rollback loader",
    "deployment rollback action",
    "deployment redeploy action",
  ];

  it.each(names)("%s authorizes in the deployment's project", async (name) => {
    expect(await scopeOf(name, { projectId: "proj_1", deploymentShortCode: "abc" })).toEqual(
      projectScope
    );
    expect(routes[name].options.authorization).toMatchObject({
      resource: { type: "deployments" },
    });
  });

  it.each(names)("%s resolves no scope for an unknown project", async (name) => {
    expect(await scopeOf(name, { projectId: "proj_missing", deploymentShortCode: "abc" })).toEqual(
      {}
    );
  });
});

describe("run routes", () => {
  const names = ["run cancel action", "run replay action"];

  it.each(names)("%s authorizes in the run's project", async (name) => {
    STATE.replicaRuns.run_1 = "env_1";
    expect(await scopeOf(name, { runParam: "run_1" })).toEqual(projectScope);
  });

  it.each(names)("%s authorizes a buffered run in its project", async (name) => {
    STATE.bufferedRuns.run_1 = { envId: "env_1", orgId: "org_1" };
    expect(await scopeOf(name, { runParam: "run_1" })).toEqual(projectScope);
  });

  it.each(names)(
    "%s authorizes a buffered run whose environment only the primary returns",
    async (name) => {
      STATE.bufferedRuns.run_1 = { envId: "env_1", orgId: "org_1" };
      STATE.resolvedEnvironments = {};
      expect(await scopeOf(name, { runParam: "run_1" })).toEqual(projectScope);
    }
  );

  it.each(names)(
    "%s resolves no scope for a buffered run with an unknown environment",
    async (name) => {
      STATE.bufferedRuns.run_1 = { envId: "env_missing", orgId: "org_1" };
      expect(await scopeOf(name, { runParam: "run_1" })).toEqual({});
    }
  );

  it.each(names)("%s authorizes a run only on the primary in its project", async (name) => {
    STATE.primaryRuns.run_1 = "env_1";
    expect(await scopeOf(name, { runParam: "run_1" })).toEqual(projectScope);
  });

  it.each(names)("%s resolves no scope for an unknown run", async (name) => {
    expect(await scopeOf(name, { runParam: "run_missing" })).toEqual({});
  });
});

describe("environment routes", () => {
  it("regenerate API key action authorizes in the environment's project", async () => {
    expect(await scopeOf("regenerate API key action", { environmentId: "env_1" })).toEqual(
      projectScope
    );
  });

  it("regenerate API key action resolves no scope for an unknown environment", async () => {
    expect(await scopeOf("regenerate API key action", { environmentId: "env_missing" })).toEqual(
      {}
    );
  });
});
