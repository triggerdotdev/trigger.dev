// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { DetailActionsMenu } from "./route";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

async function markAs(isGroup: boolean, action = vi.fn(async () => null)) {
  const router = createMemoryRouter([
    {
      path: "/",
      action,
      element: (
        <OperatingSystemContextProvider platform="mac">
          <ShortcutsProvider>
            <DetailActionsMenu
              alert={
                {
                  status: { status: "active" },
                  capabilityKey: isGroup ? "alerts.group" : "queue.depth",
                } as unknown as AlertDetail
              }
              investigatePrompt="p"
              permissions={{ canWrite: true }}
              onEdit={() => {}}
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
  roots.push(root);
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((b) => b.getAttribute("aria-label") === "Alert actions")!
      .click()
  );
  const titles = [...document.body.querySelectorAll("[role=dialog] button")].map((b) =>
    b.textContent?.trim()
  );
  return { titles, action };
}

describe("Alert actions on a group", () => {
  it("Ungroup asks to confirm, then posts intent=ungroup", async () => {
    const { titles, action } = await markAs(true);
    expect(titles).toEqual(["Edit", "Ungroup"]);
    const item = [
      ...document.body.querySelectorAll<HTMLButtonElement>("[role=dialog] button"),
    ].find((b) => b.textContent?.trim() === "Ungroup")!;
    await act(async () => item.click());
    expect(action).not.toHaveBeenCalled();
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("name") === "intent" && b.value === "ungroup"
    )!;
    await act(async () => confirm.click());
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const call = action.mock.calls[0] as unknown as [{ request: Request }];
    expect((await call[0].request.formData()).get("intent")).toBe("ungroup");
  });

  it("a plain alert has no Ungroup", async () => {
    expect((await markAs(false)).titles).toEqual(["Edit"]);
  });
});
