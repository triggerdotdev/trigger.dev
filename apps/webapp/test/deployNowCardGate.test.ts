import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCardVerificationGate: vi.fn(),
  checkDeployAccess: vi.fn(),
  triggerDeployNow: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  prisma: {
    organization: {
      findFirst: async () => ({ id: "org_1", slug: "acme", title: "Acme" }),
    },
    connectedGithubRepository: {
      findFirst: async () => ({
        branchTracking: { prod: { branch: "main" } },
        previewDeploymentsEnabled: false,
        repository: { fullName: "acme/app", installation: { appInstallationId: 1n } },
      }),
    },
  },
  $replica: {},
}));
vi.mock("~/env.server", () => ({ env: { APP_ORIGIN: "https://cloud.example.com" } }));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
}));
vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("~/services/deployNowAuthScope.server", () => ({ resolveDeployNowAuthScope: vi.fn() }));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "proj_1", organizationId: "org_1" }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: "PRODUCTION", branchName: null }),
}));
vi.mock("~/v3/services/deploymentOnboardingEnabled.server", () => ({
  deploymentOnboardingEnabled: async () => true,
}));
vi.mock("~/v3/deploymentAccess.server", () => ({ checkDeployAccess: mocks.checkDeployAccess }));
vi.mock("~/v3/cardVerificationGate.server", () => ({
  resolveCardVerificationGate: mocks.resolveCardVerificationGate,
}));
vi.mock("~/v3/github", () => ({
  BranchTrackingConfigSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
  getTrackedBranchForEnvironment: () => "main",
}));
vi.mock("~/v3/services/triggerDeployNow.server", () => ({
  TriggerDeployNowService: class {
    call = mocks.triggerDeployNow;
  },
}));

import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deploy-now";

const deployNow = action as unknown as (args: {
  params: { organizationSlug: string; projectParam: string; envParam: string };
  user: { id: string };
}) => Promise<Response>;

const request = async () => {
  const response = await deployNow({
    params: { organizationSlug: "acme", projectParam: "app", envParam: "prod" },
    user: { id: "user_1" },
  });
  return { status: response.status, body: await response.json() };
};

describe("deploy now card gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkDeployAccess.mockResolvedValue({ allowed: true });
    mocks.triggerDeployNow.mockResolvedValue({ ok: true });
  });

  // Catches: deploy now queueing a build that the card gate then fails, while the button says ok.
  it("refuses a gated org with a 403 and the card message, without queueing a build", async () => {
    mocks.resolveCardVerificationGate.mockResolvedValue("gated");
    expect(await request()).toEqual({
      status: 403,
      body: {
        ok: false,
        code: "CARD_VERIFICATION_REQUIRED",
        error:
          "Unlock your Free tier credits to deploy.\n\u201cAcme\u201d needs a card on file to use its free credits for deployments. It\u2019s a verification check only, so you won\u2019t be charged.\nAdd a card: https://cloud.example.com/orgs/acme/select-plan/card",
      },
    });
    expect(mocks.triggerDeployNow).not.toHaveBeenCalled();
  });

  // Catches: Deploy now refusing an org that may deploy, or blocking every org while billing is
  // unreadable.
  it.each(["not_gated", "unknown"] as const)("queues the deploy for a %s org", async (gate) => {
    mocks.resolveCardVerificationGate.mockResolvedValue(gate);
    expect(await request()).toEqual({ status: 200, body: { ok: true } });
    expect(mocks.triggerDeployNow).toHaveBeenCalledOnce();
    expect(mocks.resolveCardVerificationGate).toHaveBeenCalledWith("org_1");
  });

  // Catches: the card check replacing or running ahead of the deployment access preflight.
  it("keeps the deployment access preflight ahead of the card check", async () => {
    mocks.checkDeployAccess.mockResolvedValue({ allowed: false, kind: "denied" });
    expect(await request()).toEqual({
      status: 403,
      body: { ok: false, error: "Not available" },
    });
    expect(mocks.resolveCardVerificationGate).not.toHaveBeenCalled();
  });
});
