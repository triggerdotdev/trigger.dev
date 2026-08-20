import { describe, expect, it, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  consumeState: vi.fn(),
  redirectAfterAuth: vi.fn(),
  createIntegration: vi.fn(),
}));

vi.mock("~/services/session.server", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("~/models/orgIntegration.server", () => ({
  OrgIntegrationRepository: {
    consumeSlackOAuthState: mocks.consumeState,
    redirectAfterAuth: mocks.redirectAfterAuth,
  },
}));
vi.mock("~/v3/services/createOrgIntegration.server", () => ({
  CreateOrgIntegrationService: class {
    call = mocks.createIntegration;
  },
}));
vi.mock("~/utils/requestUrl.server", () => ({
  requestUrl: (request: Request) => new URL(request.url),
}));
const { loader } = await import("../app/routes/integrations.$serviceName.callback.js");

const request = () =>
  new Request("https://example.com/integrations/slack/callback?code=code_123&state=state_123");
const args = () => ({ request: request(), params: { serviceName: "slack" } }) as any;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserId.mockResolvedValue("user_123");
});

describe("Slack OAuth callback", () => {
  it("uses the consumed state scope before exchanging the authorization code", async () => {
    mocks.consumeState.mockResolvedValue({
      organizationId: "org_123",
      service: "slack",
      redirectTo: "/orgs/acme/projects/app/env/prod/alerts/new/connect-to-slack",
    });
    const response = new Response(null, { status: 302 });
    mocks.createIntegration.mockResolvedValue({ id: "integration_123" });
    mocks.redirectAfterAuth.mockResolvedValue(response);

    await expect(loader(args())).resolves.toBe(response);
    expect(mocks.consumeState).toHaveBeenCalledWith(expect.any(Request), "state_123", "user_123");
    expect(mocks.createIntegration).toHaveBeenCalledWith(
      "user_123",
      "org_123",
      "slack",
      "code_123"
    );
    expect(mocks.redirectAfterAuth).toHaveBeenCalledWith(
      expect.any(Request),
      "/orgs/acme/projects/app/env/prod/alerts/new/connect-to-slack"
    );
  });

  it("rejects invalid state before the authorization code exchange or integration writes", async () => {
    mocks.consumeState.mockResolvedValue(undefined);

    await expect(loader(args())).rejects.toMatchObject({ status: 400 });
    expect(mocks.createIntegration).not.toHaveBeenCalled();
    expect(mocks.redirectAfterAuth).not.toHaveBeenCalled();
  });

  it("clears the session binding and returns to the stored path when integration fails", async () => {
    const redirectTo = "/orgs/acme/projects/app/env/prod/alerts/new/connect-to-slack";
    mocks.consumeState.mockResolvedValue({
      organizationId: "org_123",
      service: "slack",
      redirectTo,
    });
    mocks.createIntegration.mockResolvedValue(undefined);
    const response = new Response(null, { status: 302 });
    mocks.redirectAfterAuth.mockResolvedValue(response);

    await expect(loader(args())).resolves.toBe(response);
    expect(mocks.redirectAfterAuth).toHaveBeenCalledWith(
      expect.any(Request),
      redirectTo,
      "Failed to connect to the service"
    );
  });
});
