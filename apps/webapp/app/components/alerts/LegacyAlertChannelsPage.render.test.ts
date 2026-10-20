// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertChannelListPresenterRecord } from "~/presenters/v3/AlertChannelListPresenter.server";
import { LegacyAlertChannelsPage } from "./LegacyAlertChannelsPage";

vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "org" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "proj" }) }));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "prod", type: "PRODUCTION" }),
}));
vi.mock("~/hooks/useShowSelfServe", () => ({ useShowSelfServe: () => true }));
vi.mock("~/components/Feedback", () => ({ Feedback: () => null }));
vi.mock("~/components/dashboard-agent/WhenAgentUnavailable", () => ({
  WhenAgentUnavailable: () => null,
}));
vi.mock("~/components/primitives/PageHeader", async () => {
  const { createElement } = await import("react");
  const wrap = (props: { children?: React.ReactNode }) =>
    createElement("div", null, props.children);
  return {
    NavBar: wrap,
    PageAccessories: wrap,
    PageTitle: ({ title }: { title: string }) => createElement("h1", null, title),
  };
});
vi.mock("~/components/layout/AppLayout", async () => {
  const { createElement } = await import("react");
  const wrap = (props: { children?: React.ReactNode }) =>
    createElement("div", null, props.children);
  return { PageContainer: wrap, PageBody: wrap, MainCenteredContainer: wrap };
});
vi.mock("~/components/primitives/Table", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<object>()),
    TableCellMenu: ({ popoverContent }: { popoverContent: React.ReactNode }) =>
      createElement("td", null, popoverContent),
  };
});
vi.mock("~/components/alerts/AlertsBlankStates", () => ({
  AlertsNoneDev: () => "none-dev",
  AlertsNoneDeployed: () => "none-deployed",
}));

const channel = {
  id: "chan_1",
  name: "Email to ops@example.com",
  type: "EMAIL",
  enabled: true,
  alertTypes: ["TASK_RUN", "DEPLOYMENT_FAILURE"],
  environmentTypes: ["PRODUCTION", "STAGING"],
  properties: { type: "EMAIL", email: "ops@example.com" },
} as unknown as AlertChannelListPresenterRecord;

function render(channels: AlertChannelListPresenterRecord[], used = 1) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(LegacyAlertChannelsPage, {
              alertChannels: channels,
              limits: { used, limit: 10 },
            })
          )
        ),
      },
    ],
    { initialEntries: ["/"] }
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

function headers(html: string) {
  return [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim()
  );
}

describe("LegacyAlertChannelsPage", () => {
  it("renders main's header row, title, rows and New alert button", () => {
    const html = render([channel]);
    expect(headers(html)).toEqual([
      "Name",
      "Alert types",
      "Channel",
      "Enabled",
      "Environments",
      "Actions",
    ]);
    expect(html).toContain("Project alerts");
    expect(html).toContain("Task run failure, Deployment failure");
    expect(html).toContain("New alert");
    expect(html).toContain(">Disable<");
    expect(html).toContain(">Delete<");
  });

  it("hides the New alert button at the limit", () => {
    const html = render([channel], 10);
    expect(html).not.toContain("New alert");
    expect(html).toContain("used all 10");
  });

  it("renders the blank state when there are no channels", () => {
    const html = render([]);
    expect(html).toContain("none-deployed");
    expect(headers(html)).toEqual([]);
  });
});
