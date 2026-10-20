import { beforeEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => ({ channels: [] as any[] }));

vi.mock("~/services/session.server", () => ({ requireUserId: async () => "u1" }));
vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader: () => () => {},
  dashboardAction: (_options: unknown, handler: (args: any) => unknown) => (args: any) =>
    handler({ ...args, user: { id: "u1" }, ability: { can: () => true } }),
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "p1", externalRef: "proj_ref" }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "e1", type: "PRODUCTION" }),
}));
vi.mock("~/presenters/v3/ErrorAlertChannelPresenter.server", () => ({}));
vi.mock("~/env.server", () => ({
  env: { ALERT_FROM_EMAIL: "a@x.com", ALERT_RESEND_API_KEY: "k" },
}));
vi.mock("~/db.server", () => ({
  prisma: { projectAlertChannel: { findMany: async () => [], delete: async () => {} } },
}));
vi.mock(
  "~/v3/services/baseService.server",
  async () => await import("~/v3/services/common.server")
);
vi.mock("~/v3/services/alerts/createAlertChannel.server", async () => {
  const { ServiceValidationError } = await import("~/v3/services/common.server");
  class AlertChannelChangedError extends Error {}
  return {
    AlertChannelChangedError,
    CreateAlertChannelService: class {
      async call(_ref: string, _userId: string, options: any) {
        if (options.channel.integrationId === "int_foreign") {
          throw new ServiceValidationError("Slack integration not found");
        }
        if (
          options.authorizedChannel === null &&
          created.channels.some((c) => c.deduplicationKey === options.deduplicationKey)
        ) {
          throw new AlertChannelChangedError();
        }
        created.channels.push(options);
        return { id: `c${created.channels.length}` };
      }
    },
  };
});

const { action } =
  await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.errors/route");

beforeEach(() => {
  created.channels = [];
});

describe("error alerts action", () => {
  it("writes a repeated email once", async () => {
    const body = new FormData();
    body.append("emails", "ops@example.com");
    body.append("emails", "ops@example.com");
    body.append("emails", "Ops@Example.com");

    const response = await action({
      request: new Request("http://localhost/errors", { method: "POST", body }),
      params: { organizationSlug: "org", projectParam: "proj", envParam: "prod" },
      context: {},
    } as any);

    expect(response.status).toBe(200);
    expect(created.channels.map((c) => c.deduplicationKey)).toEqual([
      "error-email:ops@example.com:PRODUCTION",
    ]);
  });

  it("returns a form error for a foreign Slack integration and writes nothing", async () => {
    const body = new FormData();
    body.append("emails", "ops@example.com");
    body.append("slackChannel", "C1/ops");
    body.append("slackIntegrationId", "int_foreign");

    const response = await action({
      request: new Request("http://localhost/errors", { method: "POST", body }),
      params: { organizationSlug: "org", projectParam: "proj", envParam: "prod" },
      context: {},
    } as any);

    const json = await response.json();
    expect(json.error[""]).toEqual(["Slack integration not found"]);
    expect(created.channels).toEqual([]);
  });
});
