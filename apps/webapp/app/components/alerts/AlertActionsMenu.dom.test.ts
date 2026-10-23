// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertListRow } from "~/presenters/v3/alertListRow";
import { AlertActionsCell, AlertActionsPopoverContent } from "./AlertsList";

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const ROW = {
  id: "alert_1",
  name: "Depth",
  conditionSummary: "> 100",
  status: "active",
  capabilityKey: "queue.depth",
  capabilityTitle: "Queue depth",
  environmentId: "env_1",
  scope: { type: "queue", queue: "emails" },
} as AlertListRow;

function renderMenu(alert: AlertListRow, openWith = vi.fn(), onClose = vi.fn()) {
  const agent = { open: false, openWith } as unknown as React.ComponentProps<
    typeof DashboardAgentProvider
  >["value"];
  const noop = () => {};
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
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
              alert,
              canWrite: true,
              canDelete: true,
              onClose,
              onResolve: noop,
              onStop: noop,
              onActivate: noop,
              onEdit: noop,
              onDelete: noop,
            })
          )
        )
      )
    )
  );
  const item = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Investigate"
  )!;
  act(() => item.click());
  act(() => root.unmount());
  container.remove();
  return { openWith, onClose };
}

describe("row Investigate", () => {
  it("closes the menu and hands the agent the full alert prompt", () => {
    const { openWith, onClose } = renderMenu(ROW);
    expect(onClose).toHaveBeenCalled();
    const prompt = openWith.mock.calls[0]![0] as string;
    expect(prompt).toContain("capabilityKey=queue.depth");
    expect(prompt).toContain("environmentId=env_1");
    expect(prompt).toContain("emails");
  });

  it("claims no scope when the row's scope is unknown", () => {
    const { openWith } = renderMenu({ ...ROW, scope: undefined });
    const prompt = openWith.mock.calls[0]![0] as string;
    expect(prompt).toContain("scope=unknown");
    expect(prompt).not.toContain("whole environment");
    expect(prompt).not.toContain("all queues");
  });
});

describe("row menu Activate placement", () => {
  function menuInfo(alert: AlertListRow) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const noop = () => {};
    act(() =>
      root.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(AlertActionsPopoverContent, {
              alert,
              canWrite: true,
              canDelete: true,
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
    const titles = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim()
    );
    const first = container.querySelector("button")?.parentElement?.firstElementChild;
    const activateFirstThenHr =
      first?.textContent?.trim() === "Activate" && first.nextElementSibling?.tagName === "HR";
    act(() => root.unmount());
    container.remove();
    return { titles, activateFirstThenHr };
  }

  it.each(["expired", "stopped", "completed"])(
    "starts with Activate then a divider, no Edit, when %s",
    (r) => {
      const menu = menuInfo({ ...ROW, status: "inactive", inactiveReason: r } as AlertListRow);
      expect(menu.titles).toContain("Activate");
      expect(menu.titles).not.toContain("Edit");
      expect(menu.activateFirstThenHr).toBe(true);
    }
  );

  it("does not show Activate for an active alert", () => {
    expect(menuInfo(ROW).titles).not.toContain("Activate");
  });
});

describe("row Activate", () => {
  const EXPIRED = {
    ...ROW,
    status: "inactive",
    inactiveReason: "expired",
    expiresAt: "2020-01-01T00:00:00.000Z",
    notifierKeys: ["channel:ch_1"],
  } as AlertListRow;

  async function clickActivate(agent: Record<string, unknown> | null) {
    const posted: FormData[] = [];
    const router = createMemoryRouter(
      [
        {
          path: "/alerts",
          action: async ({ request }) => {
            posted.push(await request.formData());
            return null;
          },
          element: createElement(
            OperatingSystemContextProvider,
            { platform: "mac" },
            createElement(
              ShortcutsProvider,
              null,
              createElement(
                DashboardAgentProvider,
                {
                  value: agent as React.ComponentProps<typeof DashboardAgentProvider>["value"],
                },
                createElement(
                  "table",
                  null,
                  createElement(
                    "tbody",
                    null,
                    createElement(
                      "tr",
                      null,
                      createElement(AlertActionsCell, {
                        alert: EXPIRED,
                        alertPath: "/alerts/alert_1",
                        canWrite: true,
                        canDelete: true,
                      })
                    )
                  )
                )
              )
            )
          ),
        },
        { path: "/alerts/alert_1", element: createElement("div", null, "detail") },
      ],
      { initialEntries: ["/alerts"] }
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(RouterProvider, { router })));
    await act(async () => container.querySelector("button")!.click());
    const item = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Activate"
    )!;
    await act(async () => item.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const location = `${router.state.location.pathname}${router.state.location.search}`;
    act(() => root.unmount());
    container.remove();
    return { posted, location };
  }

  it("opens the agent edit card in activate mode instead of posting", async () => {
    const openEditAlert = vi.fn();
    const { posted } = await clickActivate({ open: false, openWith: vi.fn(), openEditAlert });
    expect(posted).toHaveLength(0);
    expect(openEditAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertId: "alert_1",
        activate: true,
        expiresAt: "2020-01-01T00:00:00.000Z",
      })
    );
  });

  it("opens the manual edit form in activate mode without the agent", async () => {
    const { posted, location } = await clickActivate(null);
    expect(posted).toHaveLength(0);
    expect(location).toBe("/alerts/alert_1?edit=1&activate=1");
  });
});

describe("row status actions for rows with a channel issue", () => {
  function titles(alert: AlertListRow) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const noop = () => {};
    const agent = { open: false, openWith: noop } as unknown as React.ComponentProps<
      typeof DashboardAgentProvider
    >["value"];
    act(() =>
      root.render(
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
                alert,
                canWrite: true,
                canDelete: true,
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
      )
    );
    const result = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim()
    );
    act(() => root.unmount());
    container.remove();
    return result;
  }

  it("gates Resolve and Stop on the status", () => {
    const raised = titles({ ...ROW, status: "needs_attention" });
    expect(raised).toContain("Mark as Resolved");
    expect(raised).not.toContain("Mark as Inactive");
    const active = titles({ ...ROW, status: "active" });
    expect(active).toContain("Mark as Inactive");
    expect(active).not.toContain("Mark as Resolved");
  });
});

describe("AlertActionsPopoverContent permissions", () => {
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
