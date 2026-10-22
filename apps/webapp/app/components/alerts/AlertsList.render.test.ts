import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { LocaleContextProvider } from "~/components/primitives/LocaleProvider";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertListRow } from "~/presenters/v3/alertListRow";
import {
  AlertActionsPopoverContent,
  AREA_OPTIONS,
  AlertsList,
  AlertsListMenuContent,
  LastActivityCell,
  NewAlertButton,
} from "./AlertsList";
import { AlertStatusBadge, AlertStatusBreakdown } from "./AlertStatusBadge";
import { isAlertArea, AREA_LABEL, WATCHING_TOOLTIP } from "./domainIcons";
import { formatExpiresAt } from "./formatExpiresAt";

describe("AlertStatusBreakdown", () => {
  it("lists every status with its badge", () => {
    const html = renderToStaticMarkup(createElement(AlertStatusBreakdown));
    for (const [label, description] of [
      ["Active", "Evaluating on schedule, no attention needed."],
      ["Needs attention", "Condition met — raised and waiting for you to mark it resolved."],
      ["Inactive", "Not evaluating; activate to resume."],
    ]) {
      expect(html).toContain(label);
      expect(html).toContain(description);
    }
    const order = ["Active", "Needs attention", "Inactive"].map((l) => html.indexOf(`>${l}<`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });
});

describe("AlertStatusBadge", () => {
  it("renders Needs attention for needs_attention status", () => {
    const html = renderToStaticMarkup(
      createElement(AlertStatusBadge, { status: "needs_attention" })
    );
    expect(html).toContain("Needs attention");
    expect(html).toContain("text-error");
  });

  it("renders Active for active status", () => {
    const html = renderToStaticMarkup(createElement(AlertStatusBadge, { status: "active" }));
    expect(html).toContain("Active");
    expect(html).toContain("text-success");
  });

  it("renders Inactive for inactive status", () => {
    const html = renderToStaticMarkup(createElement(AlertStatusBadge, { status: "inactive" }));
    expect(html).toContain("Inactive");
    expect(html).toContain("text-text-dimmed");
  });
});

describe("domainIcons", () => {
  it("identifies known areas", () => {
    expect(isAlertArea("queues")).toBe(true);
    expect(isAlertArea("errors")).toBe(true);
    expect(isAlertArea("health")).toBe(true);
    expect(isAlertArea("runs")).toBe(true);
    expect(isAlertArea("deployments")).toBe(false);
  });

  it("rejects unknown areas", () => {
    expect(isAlertArea("unknown")).toBe(false);
    expect(isAlertArea("billing")).toBe(false);
  });

  it("provides labels for all areas", () => {
    expect(AREA_LABEL.queues).toBe("Queues");
    expect(AREA_LABEL.errors).toBe("Errors");
  });
});

describe("Expires cell formatting", () => {
  it("renders em dash when expiresAt is null", () => {
    expect(formatExpiresAt(null)).toBe("–");
  });

  it("renders plain text countdown for future dates", () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const result = formatExpiresAt(futureDate);
    expect(result).toMatch(/^in \d+/);
  });

  it("renders expired text for past dates", () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = formatExpiresAt(pastDate);
    expect(result).toMatch(/^expired .* ago$/);
  });

  it("fails if result contains time component formatting like colons", () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const result = formatExpiresAt(futureDate);
    expect(result).not.toContain("T");
    expect(result).not.toMatch(/<time/);
  });
});

describe("Watching filter", () => {
  it("fails when Watching filter offers errors", () => {
    const areaValues = AREA_OPTIONS.map((opt) => opt.value);
    expect(areaValues).toContain("errors");
  });

  it("fails when Watching filter offers deployments", () => {
    const areaValues = AREA_OPTIONS.map((opt) => opt.value);
    expect(areaValues).not.toContain("deployments");
  });

  it("includes only Queues, Errors, Runs, Health, and Unknown", () => {
    const areaValues = AREA_OPTIONS.map((opt) => opt.value);
    expect(areaValues).toEqual(["queues", "errors", "runs", "health", "unknown"]);
  });
});

describe("LastActivityCell", () => {
  const row = (lastEventAt: Date | null) =>
    ({
      status: "inactive",
      lastEventAt,
      lastActivityAt: new Date("2026-01-01"),
    }) as never;

  it("shows a dash when the alert never occurred", () => {
    const html = renderToStaticMarkup(createElement(LastActivityCell, { alert: row(null) }));
    expect(html).toContain("–");
    expect(html).not.toContain("Never raised");
  });
});

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

  it("fails when the alert count text returns", () => {
    const html = render(false);
    expect(html).not.toMatch(/\d+ alerts?</);
    expect(html).toContain("New alert");
  });

  it("fails when the truncation notice is missing or always shown", () => {
    expect(render(true)).toContain("Showing the 500 most recent alerts");
    expect(render(false)).not.toContain("most recent alerts");
  });

  it("renders exactly one tooltip trigger in the status cell", () => {
    const html = renderRow({
      episode: { kind: "raised", at: new Date(), recoveredAt: new Date() },
    });
    const cell = html.match(/<td[\s\S]*?<\/td>/)![0];
    expect(cell.match(/data-state=/g)).toHaveLength(1);
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

  it("shows a custom from/to range in the Occurred pill", () => {
    const from = Date.UTC(2030, 0, 10, 12);
    const to = Date.UTC(2030, 0, 20, 12);
    const html = renderRow({}, `/?from=${from}&to=${to}`);
    expect(html).not.toContain("Last 7 days");
    expect(html).toContain("Jan");
  });

  it("shows the channel issue triangle only when hasChannelIssue", () => {
    const cellOf = (html: string) => html.match(/<td[\s\S]*?<\/td>/)![0];
    const flagged = cellOf(renderRow({ hasChannelIssue: true }));
    expect(flagged).toContain("text-warning");
    expect(flagged.match(/data-state=/g)).toHaveLength(2);
    const clean = cellOf(renderRow({ hasChannelIssue: false }));
    expect(clean).not.toContain("text-warning");
    expect(clean.match(/data-state=/g)).toHaveLength(1);
  });

  it("renders an info tooltip trigger on the Status, Alert and Watching headers", () => {
    const head = renderRow().match(/<thead[\s\S]*?<\/thead>/)![0];
    const cells = head.match(/<th[\s\S]*?<\/th>/g)!;
    const withInfo = cells
      .filter((c) => c.includes("data-state="))
      .map((c) => c.replace(/<[^>]+>/g, "").trim());
    expect(withInfo).toEqual(["Status", "Alert", "Watching"]);
  });

  it("fails when a Resolve button returns to the row", () => {
    const html = renderRow();
    expect(html).toContain("Needs attention");
    expect(html).not.toContain("Resolve");
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

describe("AlertActionsPopoverContent", () => {
  function buttons(
    status: AlertListRow["status"],
    canWrite = true,
    canDelete = true,
    expiresAt: string | null = null
  ) {
    const noop = () => {};
    const agent = { open: false, openWith: noop } as unknown as React.ComponentProps<
      typeof DashboardAgentProvider
    >["value"];
    const html = renderToStaticMarkup(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            DashboardAgentProvider,
            { value: agent },
            createElement(AlertActionsPopoverContent, {
              alert: {
                id: "a1",
                name: "Depth",
                conditionSummary: "> 100",
                status,
                expiresAt,
              } as AlertListRow,
              canWrite,
              canDelete,
              onClose: noop,
              onResolve: noop,
              onStop: noop,
              onActivate: noop,
              onEdit: noop,
              onDelete: noop,
            })
          )
        )
      )
    );
    return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>|<hr/g)].map((m) =>
      m[0] === "<hr"
        ? { title: "---", disabled: false }
        : {
            title: m[2]!.replace(/<[^>]+>/g, "").trim(),
            disabled: m[1]!.includes('disabled=""'),
          }
    );
  }
  const titles = (status: AlertListRow["status"]) => buttons(status).map((b) => b.title);

  it("groups Mark as…, then Edit and Delete, with Investigate last", () => {
    expect(titles("needs_attention")).toEqual(["Mark as Resolved", "---", "Edit", "Investigate"]);
    expect(titles("active")).toEqual(["Mark as Inactive", "---", "Edit", "Investigate"]);
    expect(titles("inactive")).toEqual(["Activate", "---", "Delete", "Investigate"]);
  });

  it("offers Activate on an expired alert, which re-picks its expiry", () => {
    expect(buttons("inactive", true, true, "2020-01-01T00:00:00Z").map((b) => b.title)).toEqual([
      "Activate",
      "---",
      "Delete",
      "Investigate",
    ]);
  });

  it("disables every write action without write:alerts, leaving Investigate", () => {
    for (const status of ["needs_attention", "active", "inactive"] as const) {
      for (const item of buttons(status, false).filter((b) => b.title !== "---")) {
        expect(item.disabled).toBe(item.title !== "Investigate");
      }
    }
    expect(buttons("inactive").every((item) => !item.disabled)).toBe(true);
  });

  it("disables Delete without delete:alerts", () => {
    const disabled = buttons("inactive", true, false).filter((item) => item.disabled);
    expect(disabled.map((item) => item.title)).toEqual(["Delete"]);
  });
});

describe("Watching column", () => {
  it("fails when the header drops the Watching label or the shared tooltip", () => {
    const src = readFileSync(resolve(__dirname, "AlertsList.tsx"), "utf8");
    expect(src).toMatch(/tooltip=\{WATCHING_TOOLTIP\}[\s\S]*?>\s*Watching\s*<\/TableHeaderCell>/);
    expect(src).not.toMatch(/>\s*Area\s*</);
    expect(src).toContain('label="Watching"');
    expect(WATCHING_TOOLTIP).toContain("keeps an eye on");
  });
});
