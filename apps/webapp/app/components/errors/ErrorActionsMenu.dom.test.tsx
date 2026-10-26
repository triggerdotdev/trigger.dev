// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { errorGroupAlertPrefill } from "~/components/alerts/errorAlertPrefill";
import { ErrorActionsMenu } from "./ErrorActionsMenu";

type AgentValue = ComponentProps<typeof DashboardAgentProvider>["value"];

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const prefill = errorGroupAlertPrefill("my-task", "fp123");

async function openMenu(agent: AgentValue | null, watchPrefill?: typeof prefill) {
  const menu = (
    <ErrorActionsMenu
      investigatePrompt="p"
      watchPrefill={watchPrefill}
      organization={{ slug: "org" } as any}
      project={{ slug: "proj" } as any}
      environment={{ slug: "dev" } as any}
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
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Error actions"]');
  if (trigger) await act(async () => trigger.click());
  const items = Array.from(
    document.body.querySelectorAll<HTMLElement>("[role=dialog] button, [role=dialog] a")
  );
  return {
    hasTrigger: !!trigger,
    items,
    titles: items.map((b) => b.textContent?.trim()),
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("ErrorActionsMenu", () => {
  it("offers Investigate and Watch, not Create alert", async () => {
    const menu = await openMenu(
      { open: false, openWith: () => {} } as unknown as AgentValue,
      prefill
    );
    expect(menu.titles).toEqual(["Investigate", "Watch"]);
    menu.cleanup();
  });

  it("Watch opens the agent with the error group prefill", async () => {
    const openCreateAlert = vi.fn();
    const menu = await openMenu(
      { open: false, openWith: () => {}, openCreateAlert } as unknown as AgentValue,
      prefill
    );
    await act(async () => menu.items[1]!.click());
    expect(openCreateAlert).toHaveBeenCalledWith(prefill);
    menu.cleanup();
  });

  it("Watch falls back to a link without the agent, and Investigate disappears", async () => {
    const menu = await openMenu(null, prefill);
    expect(menu.titles).toEqual(["Watch"]);
    expect(menu.items[0]!.getAttribute("href")).toContain("capability=errors.occurred_again");
    menu.cleanup();
  });

  it("omits Watch when alerts are not enabled", async () => {
    const menu = await openMenu({ open: false, openWith: () => {} } as unknown as AgentValue);
    expect(menu.titles).toEqual(["Investigate"]);
    menu.cleanup();
  });

  it("renders nothing without the agent or alerts", async () => {
    const menu = await openMenu(null);
    expect(menu.hasTrigger).toBe(false);
    menu.cleanup();
  });
});
