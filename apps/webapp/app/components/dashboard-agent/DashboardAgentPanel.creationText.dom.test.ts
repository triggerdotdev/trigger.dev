// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentPanel } from "./DashboardAgentPanel";

type SeenChat = {
  chatId: string;
  sendRequest?: { text: string };
  clientData?: Record<string, unknown>;
  onTurnError?: (message: string) => void;
};

const seen = vi.hoisted(() => ({
  chats: [] as SeenChat[],
  onFreeText: undefined as ((text: string) => void) | undefined,
  systemLines: [] as Array<{ text: string; variant: string }>,
  environmentTitle: undefined as string | undefined,
}));

vi.mock("./DashboardAgentChat", () => ({
  DashboardAgentChat: (props: SeenChat) => {
    seen.chats.push({
      chatId: props.chatId,
      sendRequest: props.sendRequest,
      clientData: props.clientData,
      onTurnError: props.onTurnError,
    });
    return null;
  },
}));
vi.mock("~/components/alerts/CreationTranscript", () => ({
  CreationTranscript: (props: {
    onFreeText: (text: string) => void;
    systemLines: Array<{ text: string; variant: string }>;
    environmentTitle?: string;
  }) => {
    seen.onFreeText = props.onFreeText;
    seen.systemLines = props.systemLines;
    seen.environmentTitle = props.environmentTitle;
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

function stubFetch(intents: string[], openStatus = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const intent = (init?.body as FormData | undefined)?.get?.("intent") as string | undefined;
      if (intent) intents.push(intent);
      else intents.push(String(input));
      if (intent === "create-session") return new Response(JSON.stringify({ chatId: "chat_c" }));
      if (intent === "create") {
        return new Response(JSON.stringify({ chatId: "chat_plain", publicAccessToken: "t" }));
      }
      if (String(input).includes("chatId=chat_c")) {
        return new Response(
          JSON.stringify({ messages: [], session: { publicAccessToken: "tok" } }),
          { status: openStatus }
        );
      }
      return new Response(JSON.stringify({ chats: [], channels: [] }));
    })
  );
}

async function renderAndSend(text: string) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(DashboardAgentPanel, { onClose: () => {}, openSource: "alerts" })
        )
      ),
    },
    { path: "/resources/alerts/channels", loader: () => ({ channels: [] }) },
  ]);
  await act(async () => root.render(createElement(RouterProvider, { router })));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    seen.onFreeText!(text);
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
}

describe("DashboardAgentPanel creation free text", () => {
  beforeEach(() => {
    seen.chats = [];
    seen.onFreeText = undefined;
    seen.systemLines = [];
    seen.environmentTitle = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("sends the first turn to the alert creation chat, not a new plain chat", async () => {
    const intents: string[] = [];
    stubFetch(intents);
    await renderAndSend("alert me when the queue is deep");

    expect(intents).not.toContain("create");
    expect(seen.chats.at(-1)).toMatchObject({
      chatId: "chat_c",
      sendRequest: { text: "alert me when the queue is deep" },
      clientData: { toolScope: "alert_creation", alertDraft: expect.any(Object) },
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    expect(intents).not.toContain("delete");
  });

  // Mutation: dropping onTurnError from the panel's chat props fails this.
  it("shows a creation turn error as an error line", async () => {
    stubFetch([]);
    await renderAndSend("alert me when the queue is deep");
    await act(async () => seen.chats.at(-1)!.onTurnError!("The agent hasn't started responding."));
    expect(seen.systemLines.at(-1)).toMatchObject({
      variant: "error",
      text: "The agent hasn't started responding.",
    });
  });

  // Mutation: dropping the error line on the openChat failure path fails this.
  it("shows an error line when the creation chat fails to open", async () => {
    stubFetch([], 500);
    await renderAndSend("alert me when the queue is deep");
    expect(seen.systemLines.map((line) => line.variant)).toEqual(["user", "error"]);
    expect(seen.chats.some((chat) => chat.sendRequest)).toBe(false);
  });

  // Mutation: dropping environmentTitle from the panel's CreationTranscript props fails this.
  it("passes the environment title to the creation transcript", async () => {
    stubFetch([]);
    await renderAndSend("alert me when the queue is deep");
    expect(seen.environmentTitle).toBe("Production");
  });
});
