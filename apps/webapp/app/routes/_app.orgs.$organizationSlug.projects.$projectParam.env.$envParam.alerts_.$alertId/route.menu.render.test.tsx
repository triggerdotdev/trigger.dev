// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AgentIcon } from "~/components/dashboard-agent/agent-identity";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { DetailActionsMenu, HeaderActions } from "./route";

type AgentValue = ComponentProps<typeof DashboardAgentProvider>["value"];

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const agent = { open: false, openWith: () => {} } as unknown as AgentValue;

const ALLOWED = { canWrite: true, canDelete: true };

async function openMenu(status: string, permissions = ALLOWED) {
  const alert = { status: { status }, canActivate: true } as unknown as AlertDetail;
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OperatingSystemContextProvider platform="mac">
          <ShortcutsProvider>
            <DashboardAgentProvider value={agent}>
              <DetailActionsMenu
                alert={alert}
                investigatePrompt="p"
                permissions={permissions}
                onEdit={() => {}}
                onActivate={() => {}}
              />
            </DashboardAgentProvider>
          </ShortcutsProvider>
        </OperatingSystemContextProvider>
      ),
    },
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Alert actions"]')!;
  await act(async () => trigger.click());
  const items = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>("[role=dialog] button")
  );
  return {
    items,
    titles: items.map((b) => b.textContent?.trim()),
    disabled: items.filter((b) => b.disabled).map((b) => b.textContent?.trim()),
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("DetailActionsMenu", () => {
  it("starts an inactive alert with Activate then a divider and no Edit", async () => {
    const inactive = await openMenu("inactive");
    const hr = document.body.querySelector("[role=dialog] hr")!;
    expect(hr.previousElementSibling?.textContent?.trim()).toBe("Activate");
    expect(hr.parentElement?.firstElementChild).toBe(hr.previousElementSibling);
    expect(inactive.titles).not.toContain("Edit");
    inactive.cleanup();
    const active = await openMenu("active");
    expect(document.body.querySelector("[role=dialog] hr")).toBeNull();
    expect(active.titles).not.toContain("Activate");
    active.cleanup();
  });

  it("puts the Ask Trigger icon on Investigate", async () => {
    const menu = await openMenu("inactive");
    const item = menu.items.find((b) => b.textContent?.includes("Investigate"));
    const paths = [...renderToStaticMarkup(<AgentIcon />).matchAll(/ d="([^"]+)"/g)].map(
      (m) => m[1]!
    );
    expect(item).toBeDefined();
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(item!.innerHTML).toContain(d);
    menu.cleanup();
  });

  it("has no status actions for a raised alert, with Investigate last", async () => {
    const menu = await openMenu("needs_attention");
    expect(menu.titles).toEqual(["Edit", "Investigate"]);
    menu.cleanup();
  });

  it("puts Activate and Delete before Investigate for an inactive alert", async () => {
    const menu = await openMenu("inactive");
    expect(menu.titles).toEqual(["Activate", "Delete", "Investigate"]);
    expect(menu.disabled).toEqual([]);
    menu.cleanup();
  });

  it("disables write actions without write:alerts, leaving Investigate", async () => {
    const denied = { canWrite: false, canDelete: false };
    const raised = await openMenu("needs_attention", denied);
    expect(raised.disabled).toEqual(["Edit"]);
    raised.cleanup();
    const active = await openMenu("active", denied);
    expect(active.disabled).toEqual(["Edit"]);
    active.cleanup();
    const inactive = await openMenu("inactive", denied);
    expect(inactive.disabled).toEqual(["Activate", "Delete"]);
    inactive.cleanup();
  });

  it("disables Delete without delete:alerts", async () => {
    const menu = await openMenu("inactive", { canWrite: true, canDelete: false });
    expect(menu.disabled).toEqual(["Delete"]);
    menu.cleanup();
  });

  async function clickEdit(agent: AgentValue | null, onEdit: () => void) {
    const alert = {
      id: "a_1",
      name: "Queue depth above 100",
      conditionSummary: "Queue depth > 100",
      scopeSummary: "Queues · All queues",
      behaviorSummary: "Recurring",
      notifiers: [{ key: "channel:ch_1", label: "Ops webhook" }],
      status: { status: "active" },
    } as unknown as AlertDetail;
    const menu = (
      <DetailActionsMenu
        alert={alert}
        investigatePrompt="p"
        permissions={ALLOWED}
        onEdit={onEdit}
        onActivate={() => {}}
      />
    );
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <OperatingSystemContextProvider platform="mac">
            <ShortcutsProvider>
              {agent ? <DashboardAgentProvider value={agent}>{menu}</DashboardAgentProvider> : menu}
            </ShortcutsProvider>
          </OperatingSystemContextProvider>
        ),
      },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<RouterProvider router={router} />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Alert actions"]')!.click()
    );
    const edit = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Edit"
    )!;
    await act(async () => edit.click());
    act(() => root.unmount());
    container.remove();
  }

  it("Edit opens the agent in edit mode with the alert's current values", async () => {
    const openEditAlert = vi.fn();
    const onEdit = vi.fn();
    await clickEdit(
      { open: false, openWith: () => {}, openEditAlert } as unknown as AgentValue,
      onEdit
    );
    expect(onEdit).not.toHaveBeenCalled();
    expect(openEditAlert).toHaveBeenCalledWith({
      alertId: "a_1",
      name: "Queue depth above 100",
      conditionSummary: "Queue depth > 100",
      scopeSummary: "Queues · All queues",
      notifiers: [{ key: "channel:ch_1", label: "Ops webhook" }],
      expiresAt: null,
    });
  });

  it("Edit falls back to the inline panel without the agent", async () => {
    const onEdit = vi.fn();
    await clickEdit(null, onEdit);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

describe("HeaderActions", () => {
  async function openHeader(status: string, canWrite = true, onActivate = vi.fn()) {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <OperatingSystemContextProvider platform="mac">
            <ShortcutsProvider>
              <HeaderActions
                status={{ status } as AlertDetail["status"]}
                permissions={{ canWrite, canDelete: true }}
                onActivate={onActivate}
              />
            </ShortcutsProvider>
          </OperatingSystemContextProvider>
        ),
      },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<RouterProvider router={router} />));
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Mark Alert As")
    );
    if (trigger) await act(async () => trigger.click());
    const titles = Array.from(document.body.querySelectorAll("[role=dialog] button")).map((b) =>
      b.textContent?.trim()
    );
    const disabled = Array.from(document.body.querySelectorAll("[role=dialog] button"))
      .filter((b) => (b as HTMLButtonElement).disabled)
      .map((b) => b.textContent?.trim());
    act(() => root.unmount());
    container.remove();
    return { hasTrigger: !!trigger, titles, disabled };
  }

  it("offers Mark Alert As with the renamed status actions", async () => {
    const raised = await openHeader("needs_attention");
    expect(raised.hasTrigger).toBe(true);
    expect(raised.titles).toEqual(["Mark as Resolved"]);
    expect((await openHeader("active")).titles).toEqual(["Mark as Inactive"]);
    expect((await openHeader("inactive")).titles).toEqual(["Activate"]);
  });

  it("disables items without write permission", async () => {
    expect((await openHeader("active", false)).disabled).toEqual(["Mark as Inactive"]);
  });

  it("Mark as Resolved submits intent=resolve even if the popover unmounts", async () => {
    const action = vi.fn(async () => null);
    const router = createMemoryRouter([
      {
        path: "/",
        action,
        element: (
          <OperatingSystemContextProvider platform="mac">
            <ShortcutsProvider>
              <HeaderActions
                status={{ status: "needs_attention" } as AlertDetail["status"]}
                permissions={{ canWrite: true, canDelete: true }}
                onActivate={() => {}}
              />
            </ShortcutsProvider>
          </OperatingSystemContextProvider>
        ),
      },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<RouterProvider router={router} />));
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Mark Alert As")
    )!;
    await act(async () => trigger.click());
    const item = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("[role=dialog] button")
    ).find((b) => b.textContent?.trim() === "Mark as Resolved")!;
    await act(async () => item.click());
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const call = action.mock.calls[0] as unknown as [{ request: Request }];
    const form = await call[0].request.formData();
    expect(form.get("intent")).toBe("resolve");
    act(() => root.unmount());
    container.remove();
  });

  it("Activate opens the edit flow instead of posting", async () => {
    const onActivate = vi.fn();
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <OperatingSystemContextProvider platform="mac">
            <ShortcutsProvider>
              <HeaderActions
                status={{ status: "inactive" } as AlertDetail["status"]}
                permissions={{ canWrite: true, canDelete: true }}
                onActivate={onActivate}
              />
            </ShortcutsProvider>
          </OperatingSystemContextProvider>
        ),
      },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<RouterProvider router={router} />));
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Mark Alert As")
    )!;
    await act(async () => trigger.click());
    const item = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("[role=dialog] button")
    ).find((b) => b.textContent?.trim() === "Activate")!;
    expect(item.type).not.toBe("submit");
    await act(async () => item.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    container.remove();
  });
});
