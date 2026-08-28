import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChatMessages: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("~/db.server", () => ({ $replica: {}, prisma: {} }));
// env.server is left real: the route transitively pulls in the ClickHouse client singleton,
// which reads its URLs and tuning from the parsed env at import. A stubbed env starves those
// (`Invalid URL`); the real schema fills them from CI's CLICKHOUSE_URL, same as every other
// route test.
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
vi.mock("~/models/runtimeEnvironment.server", () => ({ findEnvironmentBySlug: vi.fn() }));
vi.mock("~/services/dashboardAgent.server", () => ({
  dashboardAgentApiOrigin: () => "https://api.trigger.dev",
  dashboardAgentUserApiOrigin: () => "https://api.trigger.dev",
  isDashboardAgentConfigured: () => true,
  mintDashboardAgentToken: vi.fn(),
  mintDashboardAgentUserActorToken: vi.fn(),
  resolveDashboardAgentRepoSnapshot: async () => null,
  startDashboardAgentSession: vi.fn(),
}));
vi.mock("~/services/dashboardAgentHeadStart.server", () => ({
  startDashboardAgentHeadStart: vi.fn(),
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/services/resolveTriggerUri.server", () => ({ resolveTriggerUri: () => null }));
vi.mock("@internal/dashboard-agent-db", () => ({
  chatExists: vi.fn(),
  countUserMessages: vi.fn(),
  createChat: vi.fn(),
  getChatMessages: mocks.getChatMessages,
  getSession: mocks.getSession,
  listChatIdsWithOpenInvestigations: vi.fn(),
  listChats: vi.fn(),
  renameChat: vi.fn(),
  setChatPinned: vi.fn(),
  softDeleteChat: vi.fn(),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { resolveOpenedChat } from "~/components/dashboard-agent/opened-chat";
import { loader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent";

function openChatRequest(chatId: string) {
  return loader({
    request: new Request(
      `https://app.trigger.dev/resources/orgs/acme/projects/api/env/dev/dashboard-agent?chatId=${chatId}`
    ),
    params: { organizationSlug: "acme", projectParam: "api", envParam: "dev" },
    context: {},
  } as any);
}

// `getChatMessages` returns null for a chat this org cannot see, and [] for one it can that
// simply has no messages yet. The route must keep those apart.
describe("dashboard agent loader — opening a chat", () => {
  beforeEach(() => {
    mocks.getChatMessages.mockReset();
    mocks.getSession.mockReset().mockResolvedValue(null);
  });

  it("reports a chat belonging to another org as not found", async () => {
    mocks.getChatMessages.mockResolvedValue(null);

    const response = await openChatRequest("chat_from_another_org");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Chat not found" });
  });

  it("still returns an empty transcript for a chat of this org that has no messages", async () => {
    mocks.getChatMessages.mockResolvedValue([]);

    const response = await openChatRequest("chat_mine");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messages: [] });
  });

  // What the client makes of the 404: a foreign chat is gone, not an empty chat to keep.
  it("resolves the not-found response as a gone chat", async () => {
    mocks.getChatMessages.mockResolvedValue(null);

    const response = await openChatRequest("chat_from_another_org");
    const data = response.ok ? await response.json() : undefined;

    expect(resolveOpenedChat("chat_from_another_org", data as any)).toEqual({ kind: "gone" });
  });
});
