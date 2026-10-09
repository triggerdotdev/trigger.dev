import { errAsync, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeExternalDeploymentId } from "@trigger.dev/core/v3";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({ env: { DEPLOYMENTS_REDEPLOY_WINDOW_DAYS: 7 } }));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({ findEnvironmentById: vi.fn() }));
vi.mock("~/services/platform.v3.server", () => ({
  enqueueGithubBuild: vi.fn(),
  enqueueBuild: vi.fn(),
}));
vi.mock("./atomicProductionDeployment.server", () => ({ atomicProductionDeploymentUrl: vi.fn() }));
vi.mock("./deployment.server", () => ({ DeploymentService: class {} }));
vi.mock("./initializeDeployment.server", () => ({ InitializeDeploymentService: class {} }));
vi.mock("./failDeployment.server", () => ({
  FINAL_DEPLOYMENT_STATUSES: ["CANCELED", "DEPLOYED", "FAILED", "TIMED_OUT"],
}));

import { ServiceValidationError } from "./baseService.server";
import { RedeployDeploymentService } from "./redeployDeployment.server";

const sha = "a".repeat(40);
const NOW = new Date("2026-09-30T12:00:00Z");

const deps = {
  findFirst: vi.fn(),
  findEnvironment: vi.fn(),
  atomicProductionUrl: vi.fn(),
  initialize: vi.fn(),
  enqueueGithub: vi.fn(),
  enqueueArtifact: vi.fn(),
  cancel: vi.fn(),
};

function service(windowDays = 7) {
  return new RedeployDeploymentService({
    prisma: { workerDeployment: { findFirst: deps.findFirst } } as never,
    windowDays,
    now: () => NOW,
    findEnvironment: deps.findEnvironment,
    atomicProductionUrl: deps.atomicProductionUrl,
    initialize: deps.initialize,
    enqueueGithub: deps.enqueueGithub,
    enqueueArtifact: deps.enqueueArtifact,
    cancel: deps.cancel,
  });
}

const gitMeta = {
  provider: "github",
  source: "trigger_github_app",
  remoteUrl: "https://github.com/owner/repo",
  commitSha: sha,
  commitRef: "feature/test",
  commitMessage: "fix build",
  dirty: false,
};

function githubDeployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "dep_failed",
    status: "FAILED",
    triggeredVia: "git_integration:github",
    environmentId: "env_1",
    createdAt: new Date("2026-09-28T10:00:00Z"),
    git: gitMeta,
    buildServerMetadata: { isNativeBuild: true, skipEnqueue: true },
    project: { buildSettings: {} },
    environment: { archivedAt: null },
    ...overrides,
  };
}

function artifactDeployment(overrides: Record<string, unknown> = {}) {
  return githubDeployment({
    triggeredVia: "cli:manual",
    git: { ...gitMeta, source: "local" },
    buildServerMetadata: {
      isNativeBuild: true,
      artifactKey: "deployments/proj_ref/prod/abc.tar.gz",
      configFilePath: "trigger.config.ts",
    },
    ...overrides,
  });
}

// findFirst resolves the source deployment, then the in-flight probe.
function mockLookups(source: unknown, inFlight: unknown = null) {
  deps.findFirst.mockReset().mockResolvedValueOnce(source).mockResolvedValueOnce(inFlight);
}

const call = (windowDays?: number, skipPromotion?: boolean) =>
  service(windowDays).call({
    userId: "user_1",
    projectId: "proj_1",
    deploymentShortCode: "abcd",
    skipPromotion,
  });
const callOk = async (windowDays?: number, skipPromotion?: boolean) =>
  (await call(windowDays, skipPromotion))._unsafeUnwrap();
const callErr = async (windowDays?: number) => (await call(windowDays))._unsafeUnwrapErr();

beforeEach(() => {
  for (const fn of Object.values(deps)) fn.mockReset();
  mockLookups(githubDeployment());
  deps.findEnvironment.mockResolvedValue({ id: "env_1", type: "PRODUCTION", projectId: "proj_1" });
  deps.atomicProductionUrl.mockResolvedValue(undefined);
  deps.initialize.mockResolvedValue({
    outcome: "created",
    deployment: {
      id: "dep_new",
      friendlyId: "deployment_new",
      shortCode: "efgh",
      version: "20260930.2",
      buildServerMetadata: { isNativeBuild: true, skipEnqueue: true },
    },
  });
  deps.enqueueGithub.mockReturnValue(okAsync({ buildId: "build_1" }));
  deps.enqueueArtifact.mockReturnValue(okAsync({ buildId: "build_2" }));
  deps.cancel.mockResolvedValue(undefined);
});

describe("RedeployDeploymentService", () => {
  it("reports notFound when the deployment does not exist", async () => {
    deps.findFirst.mockReset().mockResolvedValue(null);
    expect(await callErr()).toEqual({ type: "deployment_not_found" });
    expect(deps.initialize).not.toHaveBeenCalled();
  });

  it.each([
    ["an in-flight deployment", githubDeployment({ status: "BUILDING" })],
    ["a GitHub deployment without git metadata", githubDeployment({ git: null })],
    ["a GitHub deployment missing the commit ref", githubDeployment({ git: { commitSha: sha } })],
    ["a CLI deployment without an artifact", githubDeployment({ triggeredVia: "cli:manual" })],
    [
      "a bundle deployment",
      artifactDeployment({
        buildServerMetadata: { isNativeBuild: true, artifactKey: "bundles/x", fromBundle: true },
      }),
    ],
    [
      "a legacy build deployment",
      artifactDeployment({ buildServerMetadata: { isNativeBuild: false, artifactKey: "x" } }),
    ],
    [
      "a deployment on an archived preview branch",
      githubDeployment({ environment: { archivedAt: new Date("2026-09-29T00:00:00Z") } }),
    ],
  ])("reports not redeployable for %s", async (_label, source) => {
    mockLookups(source);
    expect(await callErr()).toEqual({ type: "deployment_not_redeployable" });
    expect(deps.findEnvironment).not.toHaveBeenCalled();
    expect(deps.initialize).not.toHaveBeenCalled();
  });

  it("reports expired for a deployment older than the window", async () => {
    const old = githubDeployment({ createdAt: new Date("2026-09-22T10:00:00Z") });
    mockLookups(old);
    expect(await callErr()).toEqual({ type: "deployment_expired" });
    expect(deps.findEnvironment).not.toHaveBeenCalled();
    mockLookups(old);
    expect((await call(30)).isOk()).toBe(true);
  });

  it("reports in flight when another deployment is in progress in the environment", async () => {
    mockLookups(githubDeployment(), { id: "dep_building" });
    expect(await callErr()).toEqual({ type: "deployment_in_flight" });
    expect(deps.findFirst.mock.calls[1]![0]).toMatchObject({
      where: {
        environmentId: "env_1",
        status: { in: ["PENDING", "INSTALLING", "BUILDING", "DEPLOYING"] },
      },
    });
    expect(deps.initialize).not.toHaveBeenCalled();
  });

  it("reports atomic production before creating a deployment", async () => {
    deps.atomicProductionUrl.mockResolvedValue("https://vercel.com/deploy");
    expect(await callErr()).toEqual({
      type: "atomic_production",
      vercelUrl: "https://vercel.com/deploy",
    });
    expect(deps.initialize).not.toHaveBeenCalled();
  });

  it("rebuilds a GitHub deployment's exact commit through the github source", async () => {
    expect(await callOk()).toEqual({ version: "20260930.2", shortCode: "efgh" });

    const [environment, payload] = deps.initialize.mock.calls[0]!;
    expect(environment.id).toBe("env_1");
    expect(payload).toMatchObject({
      contentHash: "NOT_AVAILABLE",
      type: "MANAGED",
      initialStatus: "PENDING",
      isNativeBuild: true,
      skipEnqueue: true,
      skipPromotion: false,
      triggeredVia: "git_integration:github",
      externalId: normalizeExternalDeploymentId(sha),
      userId: "user_1",
      gitMeta: { commitSha: sha, commitRef: "feature/test", source: "trigger_github_app" },
    });
    expect(payload.force).toBeUndefined();
    expect(payload.artifactKey).toBeUndefined();

    expect(deps.enqueueGithub).toHaveBeenCalledWith(
      "proj_1",
      "deployment_new",
      { commitSha: sha, ref: "feature/test" },
      { skipPromotion: false }
    );
    expect(deps.enqueueArtifact).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();

    expect(deps.initialize).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      redeployOf: "abcd",
    });
  });

  it("forces a rebuild when the commit is already deployed", async () => {
    deps.initialize
      .mockResolvedValueOnce({ outcome: "existing", deployment: { version: "20260930.1" } })
      .mockResolvedValueOnce({
        outcome: "created",
        deployment: {
          id: "dep_new",
          friendlyId: "deployment_new",
          shortCode: "efgh",
          version: "3",
        },
      });
    expect(await callOk()).toEqual({ version: "3", shortCode: "efgh" });
    expect(deps.initialize).toHaveBeenCalledTimes(2);
    expect(deps.initialize.mock.calls[0]![1].force).toBeUndefined();
    expect(deps.initialize.mock.calls[1]![1]).toMatchObject({
      force: true,
      externalId: normalizeExternalDeploymentId(sha),
    });
    expect(deps.initialize.mock.calls[1]![2]).toEqual({ redeployOf: "abcd" });
    expect(deps.enqueueGithub).toHaveBeenCalledOnce();
  });

  it("honours the project's native build opt-out for GitHub deployments", async () => {
    mockLookups(
      githubDeployment({ project: { buildSettings: { disableNativeBuildServer: true } } })
    );
    expect(await callOk()).toMatchObject({ shortCode: "efgh" });
    expect(deps.initialize.mock.calls[0]![1].isNativeBuild).toBe(false);
    expect(deps.enqueueGithub).toHaveBeenCalledOnce();
  });

  it("rebuilds a native CLI deployment from its uploaded artifact", async () => {
    mockLookups(artifactDeployment());
    expect(await callOk()).toEqual({ version: "20260930.2", shortCode: "efgh" });

    const payload = deps.initialize.mock.calls[0]![1];
    expect(payload).toMatchObject({
      isNativeBuild: true,
      artifactKey: "deployments/proj_ref/prod/abc.tar.gz",
      configFilePath: "trigger.config.ts",
      skipEnqueue: true,
      triggeredVia: "dashboard",
      gitMeta: { commitSha: sha, source: "local" },
    });
    expect(payload.externalId).toBeUndefined();
    expect(payload.force).toBeUndefined();

    expect(deps.enqueueArtifact).toHaveBeenCalledWith(
      "proj_1",
      "deployment_new",
      "deployments/proj_ref/prod/abc.tar.gz",
      { configFilePath: "trigger.config.ts", skipPromotion: false }
    );
    expect(deps.enqueueGithub).not.toHaveBeenCalled();
  });

  it("passes skipPromotion through to the deployment and the build", async () => {
    expect(await callOk(undefined, true)).toMatchObject({ shortCode: "efgh" });
    expect(deps.initialize.mock.calls[0]![1]).toMatchObject({ skipPromotion: true });
    expect(deps.enqueueGithub).toHaveBeenCalledWith(
      "proj_1",
      "deployment_new",
      { commitSha: sha, ref: "feature/test" },
      { skipPromotion: true }
    );
  });

  it("reports in flight when the platform rejects a duplicate external id", async () => {
    deps.initialize.mockRejectedValue(new ServiceValidationError("in progress", 409));
    expect(await callErr()).toEqual({ type: "deployment_in_flight" });
    expect(deps.enqueueGithub).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it("cancels the new deployment and reports the platform error when enqueue fails", async () => {
    deps.enqueueGithub.mockReturnValue(
      errAsync({ type: "build_rejected", code: "COMMIT_NOT_FOUND", error: "not found" })
    );
    expect(await callErr()).toEqual({
      type: "failed_to_enqueue_build",
      message: "The commit no longer exists in the connected repository",
    });
    expect(deps.cancel).toHaveBeenCalledWith(
      "env_1",
      "deployment_new",
      "Failed to queue the build: the commit no longer exists in the connected repository"
    );
  });

  it("explains a lost race when the platform reports the deployment is no longer pending", async () => {
    deps.enqueueGithub.mockReturnValue(
      errAsync({
        type: "build_rejected",
        code: "DEPLOYMENT_NOT_PENDING",
        error: "The deployment is no longer pending a build",
      })
    );
    expect(await callErr()).toEqual({
      type: "failed_to_enqueue_build",
      message: "Another deployment of this commit was just started",
    });
    expect(deps.cancel).toHaveBeenCalledOnce();
  });

  it("still reports the platform error when cancelling the new deployment fails", async () => {
    deps.enqueueGithub.mockReturnValue(errAsync({ type: "build_service_unreachable" }));
    deps.cancel.mockRejectedValue(new Error("cancel failed"));
    expect(await callErr()).toEqual({
      type: "failed_to_enqueue_build",
      message: "The build service could not be reached",
    });
    expect(deps.cancel).toHaveBeenCalledOnce();
  });

  it("reports other with the cause when a dependency throws", async () => {
    const boom = new Error("boom");
    deps.initialize.mockRejectedValue(boom);
    expect(await callErr()).toEqual({ type: "other", cause: boom });
    expect(deps.cancel).not.toHaveBeenCalled();
  });
});
