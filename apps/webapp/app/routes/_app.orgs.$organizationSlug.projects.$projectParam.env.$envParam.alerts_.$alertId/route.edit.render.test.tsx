// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { EditAlertPanel } from "./route";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountPanel() {
  const alert = {
    name: "My alert",
    expiresAt: null,
    conditionSummary: "x",
    scopeSummary: "y",
    notifiers: [
      { key: "channel:ok", label: "Slack" },
      { key: "channel:gone", label: "Email" },
    ],
  } as unknown as AlertDetail;
  const channels = [{ id: "ok", name: "Slack", type: "SLACK" }];
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OperatingSystemContextProvider platform="mac">
          <ShortcutsProvider>
            <EditAlertPanel
              alert={alert}
              channels={channels}
              activate={false}
              onCancel={() => {}}
            />
          </ShortcutsProvider>
        </OperatingSystemContextProvider>
      ),
    },
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(<RouterProvider router={router} />);
  });
  return container;
}

describe("EditAlertPanel unavailable notifier", () => {
  it("can be unchecked, drops from notifierIds, then stays disabled", async () => {
    const container = await mountPanel();
    const hidden = () =>
      container.querySelector<HTMLInputElement>('input[name="notifierIds"]')!.value;
    const unavailable = () =>
      Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((b) =>
        b.closest("label")?.textContent?.includes("(disabled)")
      )!;

    expect(hidden()).toBe("channel:ok,channel:gone");
    expect(unavailable().disabled).toBe(false);

    await act(async () => {
      unavailable().click();
    });

    expect(hidden()).toBe("channel:ok");
    expect(unavailable().checked).toBe(false);
    expect(unavailable().disabled).toBe(true);
  });
});
