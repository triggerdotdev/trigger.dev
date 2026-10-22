import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { LocaleContextProvider } from "~/components/primitives/LocaleProvider";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";

const loaderData = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("remix-typedjson", () => ({
  typedjson: (v: unknown) => v,
  useTypedLoaderData: () => loaderData.current,
}));
vi.mock("~/hooks/useOrganizations", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOrganization: () => ({ slug: "org", id: "o1" }),
  useOptionalOrganization: () => ({ slug: "org", id: "o1" }),
  useWidgetLimitPerDashboard: () => 10,
  useBillingLimit: () => undefined,
}));
vi.mock("~/hooks/useProject", () => ({
  useProject: () => ({ slug: "proj", id: "p1" }),
  useOptionalProject: () => ({ slug: "proj", id: "p1" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "prod", id: "e1" }),
  useOptionalEnvironment: () => ({ slug: "prod", id: "e1" }),
}));
vi.mock("~/hooks/useSearchParam", () => ({
  useSearchParams: () => ({ value: () => undefined, values: () => [] }),
}));
vi.mock("../_app.orgs.$organizationSlug/route", () => ({ useCurrentPlan: () => undefined }));
vi.mock("~/components/logs/LogsTaskFilter", () => ({ LogsTaskFilter: () => null }));
vi.mock("~/components/metrics/QueuesFilter", () => ({ QueuesFilter: () => null }));
vi.mock("~/components/metrics/ScopeFilter", () => ({ ScopeFilter: () => null }));
vi.mock("~/components/runs/v3/SharedFilters", () => ({ TimeFilter: () => null }));
vi.mock("~/components/navigation/DashboardDialogs", () => ({
  CreateDashboardPageButton: () => null,
}));
vi.mock("../resources.metric", () => ({ MetricWidget: () => null }));
vi.mock("~/components/navigation/FavoritePageButton", () => ({ FavoritePageButton: () => null }));

import Page from "./route";

const agent = {
  open: false,
  setOpen: () => {},
  openWith: () => {},
  openWithWatch: () => {},
  openCreateAlert: () => {},
  openEditAlert: () => {},
  unreadWakes: 0,
  unreadWork: 0,
  watchEnabled: false,
};

function render(alertsEnabled: boolean) {
  loaderData.current = {
    key: "overview",
    title: "Overview",
    alertsEnabled,
    layout: { layout: [], widgets: {} },
    defaultPeriod: "1d",
    filters: [],
    possibleTasks: [],
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <LocaleContextProvider locales={["en-US"]}>
          <OperatingSystemContextProvider platform="mac">
            <ShortcutsProvider>
              <DashboardAgentProvider value={agent}>
                <Page />
              </DashboardAgentProvider>
            </ShortcutsProvider>
          </OperatingSystemContextProvider>
        </LocaleContextProvider>
      ),
    },
  ]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("built-in dashboard route", () => {
  it("shows Watch when alerts are enabled", () => {
    expect(render(true)).toContain("Watch");
  });

  it("hides Watch when alerts are disabled", () => {
    expect(render(false)).not.toContain("Watch");
  });
});
