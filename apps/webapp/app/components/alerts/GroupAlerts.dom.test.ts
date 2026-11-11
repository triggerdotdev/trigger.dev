// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertListRow } from "~/presenters/v3/alertListRow";
import { AlertsList } from "./AlertsList";

vi.mock("~/hooks/useOrganizations", () => ({
  useOptionalOrganization: () => ({ slug: "org", id: "org1" }),
  useOrganization: () => ({ slug: "org", id: "org1" }),
}));
vi.mock("~/hooks/useProject", () => ({
  useOptionalProject: () => ({ slug: "proj", id: "proj1" }),
  useProject: () => ({ slug: "proj", id: "proj1" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useOptionalEnvironment: () => ({ slug: "prod", id: "env1", type: "PRODUCTION" }),
  useEnvironment: () => ({ slug: "prod", id: "env1", type: "PRODUCTION" }),
}));
vi.mock("~/hooks/useTypedMatchData", () => ({ useTypedMatchesData: () => undefined }));

Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function row(partial: Partial<AlertListRow>): AlertListRow {
  return {
    id: "alert_a",
    name: "Depth",
    area: "queues",
    conditionSummary: "> 100",
    capabilityKey: "queue.depth",
    capabilityTitle: "Queue depth",
    environmentId: "env1",
    scope: undefined,
    status: "active",
    hasChannelIssue: false,
    groupId: null,
    lastEventAt: null,
    notifierCount: 1,
    expiresAt: null,
    lastActivityAt: new Date().toISOString(),
    ...partial,
  };
}

const ROWS = [
  row({ id: "alert_a", name: "Depth" }),
  row({ id: "alert_b", name: "Failures" }),
  row({
    id: "alert_g",
    name: "Prod group",
    capabilityKey: "alerts.group",
    area: "grouped",
  }),
];

let container: HTMLElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
const openGroupAlerts = vi.fn();
const listPosts: FormData[] = [];

function renderList() {
  router = createMemoryRouter(
    [
      {
        path: "/alerts",
        action: async ({ request }) => {
          listPosts.push(await request.formData());
          return null;
        },
        element: createElement(
          OperatingSystemContextProvider,
          { platform: "mac" } as React.ComponentProps<typeof OperatingSystemContextProvider>,
          createElement(
            ShortcutsProvider,
            null,
            createElement(
              DashboardAgentProvider,
              { value: { open: false, openGroupAlerts } as never },
              createElement(AlertsList, {
                alerts: ROWS,
                hasLegacyAlerts: false,
                channelsTo: "/channels",
                legacyTo: "/legacy",
                page: 1,
                totalPages: 1,
                truncated: false,
                newAlertPath: "/new",
                newAlertPrompt: "",
                alertPath: (id: string) => `/alerts/${id}`,
                canWrite: true,
              })
            )
          )
        ),
      },
    ],
    { initialEntries: ["/alerts"] }
  );
  return act(async () => root.render(createElement(RouterProvider, { router })));
}

const bar = () => document.querySelector("[data-testid=group-bulk-bar]");
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === label
  );
const select = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`);

describe("alerts list grouping", () => {
  beforeEach(() => {
    openGroupAlerts.mockClear();
    listPosts.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("selects only ungrouped alerts and opens the agent group flow with them", async () => {
    await renderList();
    expect(select("Prod group")).toBeNull();
    expect(bar()).toBeNull();

    act(() => select("Depth")!.click());
    expect(bar()!.textContent).toContain("1 selected");
    expect(button("Group 1 alerts")!.disabled).toBe(true);
    act(() => select("Failures")!.click());
    expect(button("Group 2 alerts")!.disabled).toBe(false);

    await act(async () => button("Group 2 alerts")!.click());
    expect(openGroupAlerts).toHaveBeenCalledWith([
      { id: "alert_a", name: "Depth" },
      { id: "alert_b", name: "Failures" },
    ]);
  });

  it("shows the group row under the Grouped area with its icon", async () => {
    await renderList();
    const tr = Array.from(document.querySelectorAll("tr")).find((r) =>
      r.textContent?.includes("Prod group")
    )!;
    const area = tr.querySelector("td:nth-child(4)")!;
    expect(area.textContent).toBe("Grouped");
    expect(area.querySelector("svg")).not.toBeNull();
  });

  it("keeps the list in place while clicking inside the open rename input", async () => {
    await renderList();
    const name = document.querySelector<HTMLElement>('span[title="Depth"]')!;
    await act(async () => name.click());
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    await act(async () => input.click());
    expect(router.state.location.pathname).toBe("/alerts");
    expect(document.querySelector('input[aria-label="Name"]')).not.toBeNull();
  });

  async function openMenu(marker: string, item: string) {
    const tr = Array.from(document.querySelectorAll("tr")).find((r) =>
      r.textContent?.includes(marker)
    )!;
    await act(async () => tr.querySelector<HTMLButtonElement>("td:last-child button")!.click());
    await act(async () => button(item)!.click());
  }

  it("posts the ungroup intent after confirming", async () => {
    await renderList();
    await openMenu("Prod group", "Ungroup");
    await act(async () => button("Ungroup")!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(listPosts.map((f) => [f.get("action"), f.get("id")])).toEqual([["ungroup", "alert_g"]]);
  });

  it("posts nothing when the ungroup confirm is dismissed", async () => {
    await renderList();
    await openMenu("Prod group", "Ungroup");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(button("Ungroup")).toBeUndefined();
    expect(listPosts).toEqual([]);
  });
});
