import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AlertChannelForm } from "~/components/alerts/AlertChannelForm";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { action } from "./route";

const created = vi.hoisted(() => ({ options: undefined as any, alertsList: true }));

vi.mock("~/v3/canUseAlertsList.server", () => ({
  canUseAlertsListForSlug: async () => created.alertsList,
}));
vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (_options: any, handler: (args: unknown) => unknown) => (args: any) =>
    handler({ ...args, user: { id: "u1" }, ability: { can: () => true } });
  return { dashboardLoader: wrap, dashboardAction: wrap };
});
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "p1", externalRef: "proj_ref" }),
}));
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async (path: string) => new Response(null, { status: 302 }),
}));
vi.mock("~/v3/services/alerts/createAlertChannel.server", async () => {
  const { ServiceValidationError } = await import("~/v3/services/common.server");
  return {
    CreateAlertChannelService: class {
      async call(_ref: string, _userId: string, options: any) {
        if (options.channel.integrationId === "int_foreign") {
          throw new ServiceValidationError("Slack integration not found");
        }
        created.options = options;
        return { name: options.name };
      }
    },
  };
});
vi.mock("~/components/primitives/Dialog", () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <h2>{children}</h2>,
}));
vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "org" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "proj" }) }));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "prod", type: "PRODUCTION" }),
}));

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return action({
    request: new Request("http://localhost/alerts/new", { method: "POST", body }),
    params: { organizationSlug: "org", projectParam: "proj", envParam: "prod" },
    context: {},
  } as any);
}

describe("new channel action", () => {
  it("fails when legacy alert types or environments are dropped from create", async () => {
    const response = (await post({ type: "EMAIL", channelValue: "ops@example.com" })) as Response;
    expect(response.status).toBe(302);
    expect(created.options).toEqual({
      name: "Email to ops@example.com",
      channel: { type: "EMAIL", email: "ops@example.com" },
      alertTypes: ["TASK_RUN", "DEPLOYMENT_FAILURE", "DEPLOYMENT_SUCCESS"],
      environmentTypes: expect.arrayContaining(["DEVELOPMENT", "STAGING", "PRODUCTION", "PREVIEW"]),
    });
  });
});

describe("foreign Slack integration", () => {
  it.each([true, false])(
    "returns a form error instead of throwing (alerts list %s)",
    async (alertsList) => {
      created.alertsList = alertsList;
      try {
        const response = (await post({
          type: "SLACK",
          channelValue: "C1/ops",
          integrationId: "int_foreign",
          alertTypes: "TASK_RUN",
          environmentTypes: "PRODUCTION",
        })) as Response;
        const body = await response.json();
        expect(body.error[""]).toEqual(["Slack integration not found"]);
      } finally {
        created.alertsList = true;
      }
    }
  );
});

describe("channel form", () => {
  it("fails when Alert me when or Environment fields return", () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <OperatingSystemContextProvider platform="mac">
            <ShortcutsProvider>
              <AlertChannelForm
                mode="create"
                slack={{ status: "NOT_CONFIGURED" } as any}
                emailAlertsEnabled
                defaultType="EMAIL"
              />
            </ShortcutsProvider>
          </OperatingSystemContextProvider>
        ),
      },
    ]);
    const html = renderToStaticMarkup(<RouterProvider router={router} />);
    expect(html).toContain("Email");
    expect(html).toContain("New channel");
    expect(html).not.toContain("New alert");
    expect(html).not.toContain("Alert me when");
    expect(html).not.toContain("Environment");
  });

  it("fails when the Slack connect link is relative", () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <OperatingSystemContextProvider platform="mac">
            <ShortcutsProvider>
              <AlertChannelForm
                mode="edit"
                slack={{ status: "NOT_CONFIGURED" } as any}
                emailAlertsEnabled
                defaultType="SLACK"
              />
            </ShortcutsProvider>
          </OperatingSystemContextProvider>
        ),
      },
    ]);
    const html = renderToStaticMarkup(<RouterProvider router={router} />);
    expect(html).toContain('href="/orgs/org/projects/proj/env/prod/alerts/new/connect-to-slack"');
  });
});

describe("channel form edit without email transport", () => {
  it("fails when the stored email is hidden", () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <OperatingSystemContextProvider platform="mac">
            <ShortcutsProvider>
              <AlertChannelForm
                mode="edit"
                slack={{ status: "NOT_CONFIGURED" } as any}
                emailAlertsEnabled={false}
                defaultType="EMAIL"
                defaultChannelValue="ops@example.com"
              />
            </ShortcutsProvider>
          </OperatingSystemContextProvider>
        ),
      },
    ]);
    const html = renderToStaticMarkup(<RouterProvider router={router} />);
    expect(html).toContain('value="ops@example.com"');
  });
});
