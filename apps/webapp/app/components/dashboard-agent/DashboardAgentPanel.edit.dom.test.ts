// @vitest-environment jsdom
import { createElement, useState, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { EditAlertPrefill } from "~/components/alerts/EditAlertTranscript";
import { DashboardAgentPanel } from "./DashboardAgentPanel";

vi.mock("~/hooks/useOrganizations", () => ({
  useOrganization: () => ({ id: "org_1", slug: "org", title: "Org" }),
}));
vi.mock("~/hooks/useProject", () => ({
  useProject: () => ({ id: "proj_1", slug: "proj", name: "Proj", externalRef: "proj_ref" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ id: "env_1", slug: "prod", type: "PRODUCTION" }),
}));
vi.mock("~/hooks/useUser", () => ({ useUser: () => ({ id: "user_1", name: "U" }) }));
vi.mock("~/hooks/useDashboardAgentBaseUrl", () => ({
  useDashboardAgentBaseUrl: () => "http://localhost",
}));
vi.mock("~/hooks/useAgentPageContext", () => ({
  useAgentPageContext: () => ({ page: { kind: "other", path: "/" }, signals: [] }),
}));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
(HTMLElement.prototype as any).scrollIntoView ??= () => {};

const PREFILL: EditAlertPrefill = {
  alertId: "a_1",
  name: "Queue depth above 100",
  conditionSummary: "Queue depth > 100",
  notifiers: [{ key: "channel:ch_1", label: "Ops webhook" }],
};

let container: HTMLElement;
let root: Root;
let bumpNewChat: () => void = () => {};

function Harness() {
  const [newChatSeq, setNewChatSeq] = useState(0);
  // eslint-disable-next-line -- test harness exposes the setter
  bumpNewChat = () => setNewChatSeq((s) => s + 1);
  return createElement(DashboardAgentPanel, {
    onClose: () => {},
    editAlertRequest: { prefill: PREFILL, seq: 1 },
    newChatSeq,
  });
}

describe("DashboardAgentPanel edit mode", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ chats: [], channels: [] })))
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens the 2-step edit card, and New chat leaves edit mode", async () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: createElement(
          OperatingSystemContextProvider,
          { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
          createElement(ShortcutsProvider, null, createElement(Harness))
        ),
      },
      { path: "/resources/alerts/channels", loader: () => ({ channels: [] }) },
    ]);
    await act(async () => root.render(createElement(RouterProvider, { router })));

    const card = () => document.querySelector<HTMLElement>("[role=dialog][aria-label]");
    expect(document.querySelector('[data-testid="edit-flow"]')?.textContent).toContain(
      `Edit ${PREFILL.name}`
    );
    expect(card()?.textContent).toContain("How long should it stay active?");
    expect(card()?.textContent).toContain("1 of 2");
    await act(async () =>
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.click()
    );
    expect(card()?.textContent).toContain("Where should it notify you?");

    await act(async () => bumpNewChat());
    expect(document.querySelector('[data-testid="edit-flow"]')).toBeNull();
  });
});
