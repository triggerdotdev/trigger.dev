// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const openCreateAlert = vi.fn();
const navigate = vi.fn();
let currentParams = new URLSearchParams("create=1&area=runs&scope=task&scopeValue=x");
let agent: unknown = { openCreateAlert };
let agentAvailable = true;

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
    agentAvailable,
  }),
  useSearchParams: () => [currentParams, vi.fn()],
  useNavigate: () => navigate,
  useFetcher: () => ({ load: vi.fn(), data: { channels: [], canWrite: true } }),
}));
vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "o", id: "org1" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "p", id: "proj1" }) }));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "e", type: "PRODUCTION", id: "env1" }),
}));
vi.mock("~/hooks/useFeatures", () => ({ useFeatures: () => ({ queueMetricsEnabled: true }) }));
vi.mock("~/components/dashboard-agent/dashboardAgentLauncher", () => ({
  useDashboardAgent: () => agent,
}));
vi.mock("~/components/primitives/Resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => children,
  ResizablePanel: ({ children }: { children: ReactNode }) => children,
  ResizableHandle: () => null,
}));
vi.mock("~/components/dashboard-agent/alert-creation/ManualCreationForm", () => ({
  ManualCreationForm: ({ flow }: { flow: CreationFlowState }) =>
    createElement(
      "div",
      { "data-testid": "manual-form", "data-answers": JSON.stringify(flow.answers) },
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "fill",
          onClick: () =>
            flow.patchAnswers({
              ...flow.answers,
              what: "runs.failed",
              condition: "3",
              windowMinutes: 10,
              notifiers: ["ch1"],
              expiry: "24h",
            }),
        },
        "fill"
      ),
      createElement(
        "button",
        { type: "button", "data-testid": "create", onClick: () => flow.create() },
        "create"
      )
    ),
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
  PageContainer: ({ children }: { children: ReactNode }) => children,
  PageBody: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/primitives/PageHeader", () => ({
  NavBar: () => null,
  PageAccessories: () => null,
  PageTitle: () => null,
}));
vi.mock("~/components/primitives/Buttons", () => ({ LinkButton: () => null, Button: () => null }));
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
vi.mock("~/services/impersonation.server", () => ({}));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({}));
vi.mock("~/v3/canUseAlertsList.server", () => ({}));
vi.mock("~/v3/services/alerts/alertActions.server", () => ({}));
vi.mock("~/v3/alertsWorker.server", () => ({}));
vi.mock("~/v3/services/alerts/alertIdRouting", () => ({}));

import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
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

describe("alerts route ?create=1 with the agent", () => {
  it("does not open the manual sheet", () => {
    agent = { openCreateAlert };
    agentAvailable = true;
    currentParams = new URLSearchParams("create=1&area=runs&scope=task&scopeValue=x");
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(Page)));
    expect(container.querySelector("[data-testid=manual-alert-panel]")).toBeNull();
    expect(container.querySelector("[data-testid=manual-form]")).toBeNull();
    act(() => root.unmount());
  });
});

describe("alerts route ?create=1 without the agent", () => {
  it("opens the manual form seeded with the prefill", () => {
    agent = null;
    agentAvailable = false;
    currentParams = new URLSearchParams("create=1&area=runs&scope=task&scopeValue=x");
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(Page)));
    const form = container.querySelector("[data-testid=manual-form]");
    expect(form).not.toBeNull();
    expect(JSON.parse(form!.getAttribute("data-answers")!)).toMatchObject({
      area: "runs",
      scope: "task",
      scopeValue: "x",
    });
    act(() => root.unmount());
  });

  it("navigates to the created alert", async () => {
    agent = null;
    agentAvailable = false;
    currentParams = new URLSearchParams("create=1&area=runs&scope=task&scopeValue=x");
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ alertId: "a1" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(Page)));
    act(() => (container.querySelector("[data-testid=fill]") as HTMLButtonElement).click());
    await act(async () =>
      (container.querySelector("[data-testid=create]") as HTMLButtonElement).click()
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/orgs/o/projects/p/env/e/alerts/a1");
    vi.unstubAllGlobals();
    act(() => root.unmount());
  });
});
