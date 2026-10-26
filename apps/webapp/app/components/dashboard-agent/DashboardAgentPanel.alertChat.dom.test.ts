// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentPanel } from "./DashboardAgentPanel";

const seen = vi.hoisted(() => ({ clientData: [] as Array<Record<string, unknown>> }));

vi.mock("./DashboardAgentChat", () => ({
  DashboardAgentChat: (props: { clientData: Record<string, unknown> }) => {
    seen.clientData.push(props.clientData);
    return null;
  },
}));
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

let container: HTMLElement;
let root: Root;

async function openFromHistory(kind: "alert_creation" | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("chatId=chat_a")) {
        return new Response(JSON.stringify({ messages: [], session: null }));
      }
      return new Response(
        JSON.stringify({
          chats: [{ id: "chat_a", title: "Queue depth", lastMessageAt: null, kind }],
          channels: [],
        })
      );
    })
  );
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(DashboardAgentPanel, {
            onClose: () => {},
            openChatRequest: { chatId: "chat_a", seq: 1 },
          })
        )
      ),
    },
  ]);
  await act(async () => root.render(createElement(RouterProvider, { router })));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return seen.clientData.at(-1);
}

describe("DashboardAgentPanel reopening an alert creation chat", () => {
  beforeEach(() => {
    seen.clientData = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("sends the alert creation scope outside creation mode", async () => {
    expect(await openFromHistory("alert_creation")).toMatchObject({ toolScope: "alert_creation" });
  });

  it("sends no scope for a plain chat", async () => {
    const clientData = await openFromHistory(null);
    expect(clientData).toBeDefined();
    expect(clientData).not.toHaveProperty("toolScope");
  });
});
