// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const openCreateAlert = vi.fn();
let currentParams = new URLSearchParams("create=1&area=runs&scope=task&scopeValue=x");

vi.mock("@remix-run/react", () => ({
  Outlet: () => null,
  useLoaderData: () => ({
    mode: "new",
    alerts: [],
    page: 1,
    totalPages: 1,
    truncated: false,
    hasLegacyAlerts: false,
    hasMigratableLegacyAlerts: false,
    canWrite: true,
    canDelete: true,
  }),
  useSearchParams: () => [currentParams, vi.fn()],
}));
vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "o" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "p" }) }));
vi.mock("~/hooks/useEnvironment", () => ({ useEnvironment: () => ({ slug: "e", type: "PROD" }) }));
vi.mock("~/components/dashboard-agent/dashboardAgentLauncher", () => ({
  useDashboardAgent: () => ({ openCreateAlert }),
}));
vi.mock("~/components/alerts/AlertsList", () => ({ AlertsList: () => null }));
vi.mock("~/components/alerts/LegacyAlertsBanner", () => ({ LegacyAlertsBanner: () => null }));
vi.mock("~/components/alerts/LegacyAlertChannelsPage", () => ({
  LegacyAlertChannelsPage: () => null,
}));
vi.mock("~/components/dashboard-agent/WhenAgentUnavailable", () => ({
  WhenAgentUnavailable: () => null,
}));
vi.mock("~/components/layout/AppLayout", () => ({
  PageContainer: () => null,
  PageBody: () => null,
}));
vi.mock("~/components/primitives/PageHeader", () => ({
  NavBar: () => null,
  PageAccessories: () => null,
  PageTitle: () => null,
}));
vi.mock("~/components/primitives/Buttons", () => ({ LinkButton: () => null }));
vi.mock("~/components/alerts/hasLegacyAlerts.server", () => ({}));
vi.mock("~/db.server", () => ({ prisma: {} }));
vi.mock("~/models/message.server", () => ({}));
vi.mock("~/models/project.server", () => ({}));
vi.mock("~/models/runtimeEnvironment.server", () => ({}));
vi.mock("~/presenters/v3/AlertChannelListPresenter.server", () => ({}));
vi.mock("~/presenters/v3/AlertsListPresenter.server", () => ({}));
vi.mock("~/services/projectAuthScope.server", () => ({}));
vi.mock("~/services/dashboardAgentDb.server", () => ({}));
vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({ dashboardLoader: () => ({}) }));
vi.mock("~/services/rbac.server", () => ({}));
vi.mock("~/services/session.server", () => ({}));
vi.mock("~/v3/canUseAlertsList.server", () => ({}));
vi.mock("~/v3/services/alerts/alertActions.server", () => ({}));
vi.mock("~/v3/alertsWorker.server", () => ({}));
vi.mock("~/v3/services/alerts/alertIdRouting", () => ({}));

import Page from "./route";

describe("alerts route ?create=1 prefill", () => {
  it("passes area, scope and scopeValue to openCreateAlert", () => {
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Page)));
    expect(openCreateAlert).toHaveBeenCalledWith({
      area: "runs",
      capability: undefined,
      scope: "task",
      scopeValue: "x",
    });
    act(() => root.unmount());
  });

  it("captures the area when create=1 arrives after first render", () => {
    openCreateAlert.mockClear();
    currentParams = new URLSearchParams("");
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Page)));
    expect(openCreateAlert).not.toHaveBeenCalled();
    currentParams = new URLSearchParams("create=1&area=runs&scope=task&scopeValue=x");
    act(() => root.render(createElement(Page)));
    expect(openCreateAlert).toHaveBeenCalledWith({
      area: "runs",
      capability: undefined,
      scope: "task",
      scopeValue: "x",
    });
    act(() => root.unmount());
  });
});
