import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { LocaleContextProvider } from "~/components/primitives/LocaleProvider";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertListRow } from "~/presenters/v3/alertListRow";
import { AlertsList, AlertsListMenuContent, NewAlertButton } from "./AlertsList";

describe("AlertsListMenuContent", () => {
  function markup(hasLegacyAlerts: boolean) {
    return renderToStaticMarkup(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            MemoryRouter,
            null,
            createElement(AlertsListMenuContent, {
              hasLegacyAlerts,
              channelsTo: "/orgs/org/projects/proj/env/prod/alerts/channels",
              legacyTo: "/alerts/legacy",
            })
          )
        )
      )
    );
  }

  it("fails when Legacy alerts shows without legacy alerts", () => {
    const html = markup(false);
    expect(html).toContain("Channels");
    expect(html).not.toContain("Legacy alerts");
  });

  it("fails when Legacy alerts is missing with legacy alerts", () => {
    expect(markup(true)).toContain("Legacy alerts");
  });
});

describe("AlertsList empty states", () => {
  function renderEmpty(url: string) {
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
              createElement(AlertsList, {
                alerts: [],
                newAlertPath: "/new",
                newAlertPrompt: "p",
                alertPath: (id: string) => `/${id}`,
                canWrite: true,
                canDelete: true,
                hasLegacyAlerts: false,
                channelsTo: "/orgs/org/projects/proj/env/prod/alerts/channels",
                legacyTo: "/legacy",
                page: 1,
                totalPages: 1,
                truncated: false,
              })
            )
          ),
        },
      ],
      { initialEntries: [url] }
    );
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  }

  it("shows the first-alert empty state with a New alert action when nothing exists", () => {
    const html = renderEmpty("/");
    expect(html).toContain("Create your first alert");
    expect(html).toContain("New alert");
    expect(html).not.toContain("No alerts match these filters");
  });

  it("shows the filters variant with Clear filters when filters match nothing", () => {
    const html = renderEmpty("/?search=cpu");
    expect(html).toContain("No alerts match these filters");
    expect(html).toContain("Clear filters");
    expect(html).not.toContain("Create your first alert");
  });
});

describe("AlertsList header", () => {
  function render(truncated: boolean) {
    const router = createMemoryRouter([
      {
        path: "/",
        element: createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(AlertsList, {
              alerts: [],
              newAlertPath: "/new",
              newAlertPrompt: "p",
              alertPath: (id: string) => `/${id}`,
              canWrite: true,
              canDelete: true,
              hasLegacyAlerts: false,
              channelsTo: "/orgs/org/projects/proj/env/prod/alerts/channels",
              legacyTo: "/legacy",
              page: 1,
              totalPages: 1,
              truncated,
            })
          )
        ),
      },
    ]);
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  }

  it("fails when the truncation notice is missing or always shown", () => {
    expect(render(true)).toContain("Showing the 500 most recent alerts");
    expect(render(false)).not.toContain("most recent alerts");
  });

  function renderRow(overrides: Partial<AlertListRow> = {}, url = "/") {
    const row = {
      id: "a1",
      name: "Depth",
      area: "queues",
      conditionSummary: "> 100",
      status: "needs_attention",
      lastEventAt: new Date(),
      notifierCount: 0,
      expiresAt: null,
      lastActivityAt: new Date(),
      ...overrides,
    } as AlertListRow;
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
              createElement(
                LocaleContextProvider,
                { locales: ["en-US"] },
                createElement(AlertsList, {
                  alerts: [row],
                  newAlertPath: "/new",
                  newAlertPrompt: "p",
                  alertPath: (id: string) => `/${id}`,
                  canWrite: true,
                  canDelete: true,
                  hasLegacyAlerts: false,
                  channelsTo: "/orgs/org/projects/proj/env/prod/alerts/channels",
                  legacyTo: "/legacy",
                  page: 1,
                  totalPages: 1,
                  truncated: false,
                })
              )
            )
          ),
        },
      ],
      { initialEntries: [url] }
    );
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  }

  it("shows the channel issue triangle only when hasChannelIssue", () => {
    const cellOf = (html: string) => html.match(/<td[\s\S]*?<\/td>/)![0];
    const flagged = cellOf(renderRow({ hasChannelIssue: true }));
    expect(flagged.match(/data-state=/g)).toHaveLength(2);
    const clean = cellOf(renderRow({ hasChannelIssue: false }));
    expect(clean.match(/data-state=/g)).toHaveLength(1);
  });
});

describe("NewAlertButton", () => {
  function markup(open: boolean) {
    const agent = { open } as React.ComponentProps<typeof DashboardAgentProvider>["value"];
    return renderToStaticMarkup(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            DashboardAgentProvider,
            { value: agent },
            createElement(NewAlertButton, { prompt: "p", path: "/alerts/new" })
          )
        )
      )
    );
  }

  it("dims while the agent panel is open", () => {
    expect(markup(true)).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*New alert/);
    expect(markup(false)).not.toContain('disabled=""');
  });
});
