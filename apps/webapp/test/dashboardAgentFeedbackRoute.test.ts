import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  resolveContext: vi.fn(),
  feedback: vi.fn(),
}));

vi.mock("~/services/uatRoutePreamble.server", () => ({
  authenticateUatOrApiRequest: mocks.authenticate,
}));
vi.mock("~/services/dashboardAgentAlertContext.server", () => ({
  resolveAgentAlertContext: mocks.resolveContext,
}));
vi.mock("~/services/telemetry.server", () => ({
  telemetry: { dashboardAgent: { feedback: mocks.feedback } },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { action } from "~/routes/api.v1.dashboard-agent.feedback";

const AGENT_ACTOR = { userId: "user_1", client: "dashboard-agent", environmentId: "env_1" };
const ENVIRONMENT = { id: "env_1", organizationId: "org_1", project: { id: "proj_1" } };

function post(body: unknown) {
  return action({
    request: new Request("https://app.trigger.dev/api/v1/dashboard-agent/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer uat" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as any);
}

beforeEach(() => {
  mocks.authenticate.mockReset().mockResolvedValue({ userActor: AGENT_ACTOR });
  mocks.resolveContext.mockReset().mockResolvedValue({ ok: true, environment: ENVIRONMENT });
  mocks.feedback.mockReset().mockReturnValue(true);
});

describe("POST /api/v1/dashboard-agent/feedback", () => {
  it("attributes the report from the token and the chat, never from the body", async () => {
    const response = await post({
      chatId: "chat_1",
      message: "get_queue 500s on a paused queue",
      toolName: "get_queue",
      userId: "user_spoofed",
      organizationId: "org_spoofed",
    });

    expect(response.status).toBe(200);
    expect(mocks.resolveContext).toHaveBeenCalledWith({
      userId: "user_1",
      environmentId: "env_1",
      chatId: "chat_1",
    });
    expect(mocks.feedback).toHaveBeenCalledWith({
      userId: "user_1",
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      chatId: "chat_1",
      message: "get_queue 500s on a paused queue",
      toolName: "get_queue",
    });
  });

  it.each([
    ["no token", undefined],
    ["a token from another client", { userActor: { ...AGENT_ACTOR, client: "mcp" } }],
  ])("refuses %s", async (_label, authentication) => {
    mocks.authenticate.mockResolvedValue(authentication);

    const response = await post({ chatId: "chat_1", message: "hi" });

    expect(response.status).toBe(401);
    expect(mocks.feedback).not.toHaveBeenCalled();
  });

  it("records nothing for a chat the user doesn't own", async () => {
    mocks.resolveContext.mockResolvedValue({
      ok: false,
      code: "chat_not_found",
      error: "Chat not found",
    });

    const response = await post({ chatId: "chat_other", message: "hi" });

    expect(response.status).toBe(404);
    expect(mocks.feedback).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversized message", async () => {
    expect((await post({ chatId: "chat_1", message: "   " })).status).toBe(400);
    expect((await post({ chatId: "chat_1", message: "x".repeat(4001) })).status).toBe(400);
    expect(mocks.feedback).not.toHaveBeenCalled();
  });

  it("answers 501 when the instance doesn't collect feedback", async () => {
    mocks.feedback.mockReturnValue(false);

    const response = await post({ chatId: "chat_1", message: "docs say X, product does Y" });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: "feedback_not_configured" });
  });
});
