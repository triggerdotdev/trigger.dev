/**
 * The watch-create confirm path: no `draft.target` re-authorizes the URL's own
 * environment exactly as before; a `draft.target` re-authorizes THAT environment and
 * requires it to stay inside the URL's own organization — a user's membership
 * elsewhere is not license to watch across orgs from this chat.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchDraft } from "@internal/dashboard-agent-contracts";

const mocks = vi.hoisted(() => ({
  authorizeWatchEnvironmentById: vi.fn(),
  submitDashboardAgentWatch: vi.fn(),
  findEnvironmentBySlug: vi.fn(),
}));

vi.mock("~/db.server", () => ({ $replica: {}, prisma: {} }));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "usr_real", admin: false, isImpersonating: false }),
}));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({
    id: "proj_real",
    organizationId: "org_real",
    externalRef: "proj_ref_real",
  }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: mocks.findEnvironmentBySlug,
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/services/resolveTriggerUri.server", () => ({ resolveTriggerUri: () => null }));
// The chat route reaches the ClickHouse factory through the watch services, and the factory
// builds its client at import time from an env var no test sets.
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("~/services/dashboardAgentWatches.server", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  authorizeWatchEnvironmentById: mocks.authorizeWatchEnvironmentById,
  submitDashboardAgentWatch: mocks.submitDashboardAgentWatch,
}));

import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent";

const SPEC = {
  kind: "backlog_drain" as const,
  queue: "my-queue",
  checkEveryMinutes: 15 as const,
  maxHours: 6,
  note: "checking on the backlog",
};

function watchCreateRequest(draft: WatchDraft) {
  const form = new URLSearchParams({
    intent: "watch-create",
    clientRequestId: "req_1",
    draft: JSON.stringify(draft),
  });

  return action({
    request: new Request(
      "https://app.trigger.dev/resources/orgs/acme/projects/api/env/dev/dashboard-agent",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }
    ),
    params: { organizationSlug: "acme", projectParam: "api", envParam: "dev" },
    context: {},
  } as any);
}

describe("watch-create target resolution", () => {
  beforeEach(() => {
    mocks.authorizeWatchEnvironmentById.mockReset();
    mocks.submitDashboardAgentWatch.mockReset().mockResolvedValue({
      ok: true,
      watching: true,
      watchId: "watch_1",
      chatId: "chat_1",
      messages: [],
    });
    mocks.findEnvironmentBySlug.mockReset().mockResolvedValue({ id: "env_url" });
  });

  it("re-authorizes the URL's own environment when no target is given", async () => {
    mocks.authorizeWatchEnvironmentById.mockResolvedValue({
      id: "env_url",
      organizationId: "org_real",
    });

    const response = await watchCreateRequest({
      spec: SPEC,
      followUp: { investigateOnAttention: false, notifyExternally: false },
    });

    expect(response.status).toBe(200);
    expect(mocks.findEnvironmentBySlug).toHaveBeenCalledTimes(1);
    expect(mocks.authorizeWatchEnvironmentById).toHaveBeenCalledWith({
      userId: "usr_real",
      environmentId: "env_url",
    });
    expect(mocks.submitDashboardAgentWatch.mock.calls[0][0].environment.id).toBe("env_url");
  });

  it("resolves and authorizes a same-org sibling target instead of the URL's environment", async () => {
    mocks.authorizeWatchEnvironmentById.mockResolvedValue({
      id: "env_sibling",
      organizationId: "org_real",
    });

    const response = await watchCreateRequest({
      spec: SPEC,
      followUp: { investigateOnAttention: false, notifyExternally: false },
      target: { environmentId: "env_sibling" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ watching: true, watchId: "watch_1" });
    // The URL's environment is never looked up on the target path.
    expect(mocks.findEnvironmentBySlug).not.toHaveBeenCalled();
    expect(mocks.authorizeWatchEnvironmentById).toHaveBeenCalledWith({
      userId: "usr_real",
      environmentId: "env_sibling",
    });
    expect(mocks.submitDashboardAgentWatch.mock.calls[0][0].environment.id).toBe("env_sibling");
  });

  it("refuses a target environment in a different organization with a clean 4xx", async () => {
    mocks.authorizeWatchEnvironmentById.mockResolvedValue({
      id: "env_foreign",
      organizationId: "org_other",
    });

    const response = await watchCreateRequest({
      spec: SPEC,
      followUp: { investigateOnAttention: false, notifyExternally: false },
      target: { environmentId: "env_foreign" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "invalid_target" });
    expect(mocks.submitDashboardAgentWatch).not.toHaveBeenCalled();
  });

  it("refuses a target environment the user has no access to", async () => {
    mocks.authorizeWatchEnvironmentById.mockResolvedValue(null);

    const response = await watchCreateRequest({
      spec: SPEC,
      followUp: { investigateOnAttention: false, notifyExternally: false },
      target: { environmentId: "env_gone" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "invalid_target" });
    expect(mocks.submitDashboardAgentWatch).not.toHaveBeenCalled();
  });
});
