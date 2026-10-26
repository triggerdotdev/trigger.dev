// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { DraftPrefillParams } from "~/components/dashboard-agent/alert-creation/flow-state";

const openCreateAlert = vi.fn();
let agent: unknown = null;

vi.mock("@remix-run/react", () => ({
  useLoaderData: () => ({
    legacyChannels: [
      {
        id: "ch1",
        name: "Ops webhook",
        channelKind: "Webhook",
        enabled: true,
        alertTypes: ["TASK_RUN"],
        alertTypeLabels: ["Task run failure"],
        environmentNames: ["production"],
      },
    ],
    canWrite: true,
    canDelete: true,
    replaceEnvironments: {
      ch1: [{ id: "env1", type: "PRODUCTION", slug: "prod", branchName: null }],
    },
  }),
  useFetcher: () => ({ state: "idle", submit: vi.fn() }),
  useNavigate: () => vi.fn(),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}));
vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "o" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "p" }) }));
vi.mock("~/hooks/useEnvironment", () => ({ useEnvironment: () => ({ slug: "e" }) }));
vi.mock("~/components/dashboard-agent/dashboardAgentLauncher", () => ({
  useDashboardAgent: () => agent,
}));
vi.mock("~/components/alerts/ManualAlertCreation", () => ({
  ManualAlertCreationDock: ({
    open,
    prefill,
    children,
  }: {
    open: boolean;
    prefill: DraftPrefillParams;
    children: ReactNode;
  }) => [
    children,
    open
      ? createElement("div", { key: "dock", "data-testid": "dock" }, JSON.stringify(prefill))
      : null,
  ],
}));
vi.mock("~/components/layout/AppLayout", () => ({
  PageContainer: ({ children }: { children: ReactNode }) => children,
  PageBody: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/primitives/PageHeader", () => ({
  NavBar: () => null,
  PageTitle: () => null,
}));
vi.mock("~/components/alerts/hasLegacyAlerts.server", () => ({}));
vi.mock("~/models/message.server", () => ({}));
vi.mock("~/models/project.server", () => ({}));
vi.mock("~/models/runtimeEnvironment.server", () => ({}));
vi.mock("~/presenters/v3/AlertChannelListPresenter.server", () => ({}));
vi.mock("~/services/logger.server", () => ({}));
vi.mock("~/services/projectAuthScope.server", () => ({}));
vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader: () => ({}),
  dashboardAction: () => ({}),
}));
vi.mock("~/db.server", () => ({ prisma: {} }));
vi.mock("~/services/dashboardAgentDb.server", () => ({}));
vi.mock("@internal/dashboard-agent-db", () => ({}));
vi.mock("~/v3/services/alerts/validateNotifierChannels.server", () => ({}));
vi.mock("~/v3/services/common.server", () => ({ ServiceValidationError: class {} }));
vi.mock("~/v3/services/alerts/deleteLegacySubscription.server", () => ({}));
vi.mock("~/v3/services/dashboardResourceAccess.server", () => ({}));
vi.mock("~/v3/services/alerts/replaceLegacySubscription.server", () => ({}));
vi.mock("~/v3/canUseAlertsList.server", () => ({}));

import Page from "./route";

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(ShortcutsProvider, null, createElement(Page))
      )
    )
  );
  const replace = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Replace with new Alert"
  )!;
  return { container, root, replace };
}

describe("legacy alerts replace without the agent", () => {
  it("enables Replace with the Watch icon and opens the manual dock for the row", () => {
    agent = null;
    const { container, root, replace } = renderPage();
    expect(replace.disabled).toBe(false);
    expect(replace.querySelector("svg.text-alerts")).not.toBeNull();
    expect(container.querySelector("[data-testid=dock]")).toBeNull();
    act(() => replace.click());
    const dock = container.querySelector("[data-testid=dock]");
    expect(JSON.parse(dock!.textContent!)).toEqual({
      capability: "runs.failed",
      scope: "all",
      replace: {
        channelId: "ch1",
        channelName: "Ops webhook",
        alertType: "TASK_RUN",
        environments: [{ id: "env1", type: "PRODUCTION", slug: "prod", branchName: null }],
      },
    });
    act(() => root.unmount());
    container.remove();
  });

  it("hands Replace to the agent when it is available", () => {
    agent = { openCreateAlert };
    const { container, root, replace } = renderPage();
    expect(replace.querySelector("svg.text-alerts")).toBeNull();
    act(() => replace.click());
    expect(openCreateAlert).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid=dock]")).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
