// @vitest-environment jsdom
import { createElement, useEffect, useState, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentPanel } from "./DashboardAgentPanel";

type Request = { text: string; seq: number; newChat?: boolean };
type SeenChat = { chatId: string; sendRequest?: { text: string; chatId: string } };

const seen = vi.hoisted(() => ({
  chats: [] as SeenChat[],
  setRequest: undefined as ((request: unknown) => void) | undefined,
}));

vi.mock("./DashboardAgentChat", () => ({
  DashboardAgentChat: (props: SeenChat) => {
    seen.chats.push(props);
    return createElement("div", { "data-chat": props.chatId });
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

const mount = { stored: false, request: undefined as Request | undefined };

function Host() {
  const [requestedMessage, setRequest] = useState<Request | undefined>(mount.request);
  useEffect(() => {
    seen.setRequest = setRequest as (request: unknown) => void;
  }, []);
  return createElement(DashboardAgentPanel, {
    onClose: () => {},
    openChatRequest: mount.stored ? undefined : { chatId: "chat_a", seq: 1 },
    requestedMessage,
  });
}

const chatShown = (id: string) => container.querySelector(`[data-chat=${id}]`) !== null;
const loaderShown = () => container.querySelector("[role=status]") !== null;

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

type CreateMode = "ok" | "hold" | "fail";

async function openWithRequest(request?: Request, createMode: CreateMode = "ok") {
  const created: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body as FormData | undefined;
      if (body?.get?.("intent") === "create") {
        created.push(JSON.parse(String(body.get("message"))).parts[0].text);
        if (createMode === "hold") await held;
        if (createMode === "fail") return new Response("{}", { status: 500 });
        return new Response(JSON.stringify({ chatId: "chat_new", publicAccessToken: "tok" }));
      }
      if (url.includes("chatId=chat_a")) {
        return new Response(
          JSON.stringify({ messages: [], session: { publicAccessToken: "tok" } })
        );
      }
      return new Response(JSON.stringify({ chats: [], channels: [] }));
    })
  );
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(ShortcutsProvider, null, createElement(Host))
      ),
    },
  ]);
  await act(async () => root.render(createElement(RouterProvider, { router })));
  await flush();
  let rendersAfterRequest: SeenChat[] = [];
  if (request) {
    expect(seen.chats.at(-1)?.chatId).toBe("chat_a");
    const before = seen.chats.length;
    await act(async () => seen.setRequest!(request));
    rendersAfterRequest = seen.chats.slice(before);
    await flush();
  }
  return { created, release, rendersAfterRequest };
}

describe("DashboardAgentPanel requestedMessage with an open chat", () => {
  beforeEach(() => {
    seen.chats = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    mount.stored = false;
    mount.request = undefined;
  });

  it("starts a new chat when newChat is set", async () => {
    // Catches: a Watch request landing in the previously open chat instead of a new one.
    const { created } = await openWithRequest({ text: "watch this", seq: 1, newChat: true });
    expect(created).toEqual(["watch this"]);
    expect(seen.chats.at(-1)?.chatId).toBe("chat_new");
    expect(chatShown("chat_new")).toBe(true);
    expect(loaderShown()).toBe(false);
  });

  it("shows the loader instead of the open chat while the new chat is created", async () => {
    // Catches: the old chat flashing on screen while the new chat is being created.
    const { release, rendersAfterRequest } = await openWithRequest(
      { text: "watch this", seq: 1, newChat: true },
      "hold"
    );
    expect(rendersAfterRequest.some((c) => c.chatId === "chat_a")).toBe(false);
    expect(chatShown("chat_a")).toBe(false);
    expect(loaderShown()).toBe(true);
    await act(async () => release());
    await flush();
    expect(chatShown("chat_new")).toBe(true);
  });

  it("never shows the stored chat when mounted with a pending newChat request", async () => {
    // Catches: a freshly mounted panel restoring and showing the stored chat before the new one.
    window.localStorage.setItem(
      "tdev:dashboard-agent:last-chat:org_1",
      JSON.stringify({ chatId: "chat_a", path: "/" })
    );
    mount.stored = true;
    mount.request = { text: "watch this", seq: 1, newChat: true };
    const { release } = await openWithRequest(undefined, "hold");
    expect(seen.chats.some((c) => c.chatId === "chat_a")).toBe(false);
    expect(loaderShown()).toBe(true);
    await act(async () => release());
    await flush();
    expect(chatShown("chat_new")).toBe(true);
  });

  it("clears the loader when creating the new chat fails", async () => {
    // Catches: an endless spinner after the new chat fails to create.
    await openWithRequest({ text: "watch this", seq: 1, newChat: true }, "fail");
    expect(loaderShown()).toBe(false);
    expect(chatShown("chat_a")).toBe(false);
  });

  it("sends into the open chat without newChat", async () => {
    // Catches: the new-chat behaviour leaking into ordinary openWith requests such as Investigate.
    const { created } = await openWithRequest({ text: "investigate", seq: 1 });
    expect(created).toEqual([]);
    expect(loaderShown()).toBe(false);
    expect(chatShown("chat_a")).toBe(true);
    expect(seen.chats.at(-1)).toMatchObject({
      chatId: "chat_a",
      sendRequest: { text: "investigate", chatId: "chat_a" },
    });
  });
});
