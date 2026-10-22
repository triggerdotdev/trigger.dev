// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardAgentChat } from "./DashboardAgentChat";

const state = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  quota: { kind: "unlimited" } as Record<string, unknown>,
  pollSeq: 0,
  sendMessage: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    setMessages: () => {},
    sendMessage: state.sendMessage,
    regenerate: () => {},
    status: state.error ? "error" : "ready",
    stop: () => {},
    error: state.error,
    clearError: () => {},
  }),
}));
vi.mock("@trigger.dev/sdk/chat/react", () => ({ useTriggerChatTransport: () => ({}) }));
vi.mock("./useAgentMessageQuota", () => ({
  useAgentMessageQuota: () => ({
    ...state.quota,
    pollSeq: state.pollSeq,
    pollIsFresh: true,
    provenCapacity: state.quota.kind !== "reached",
  }),
}));
vi.mock("./useTriggerUriResolver", () => ({ useTriggerUriResolver: () => () => null }));
vi.mock("./DashboardAgentMessages", () => ({ DashboardAgentMessages: () => null }));
vi.mock("./DashboardAgentHero", () => ({ DashboardAgentHero: () => null }));
vi.mock("./DashboardAgentComposer", () => ({ DashboardAgentComposer: () => null }));
vi.mock("./DashboardAgentContextBanner", () => ({ DashboardAgentContextBanner: () => null }));
vi.mock("./WatchChips", () => ({ WatchChips: () => null }));
vi.mock("./AgentUpgradeGate", () => ({
  AgentUpgradeBlock: () => null,
  AgentQuotaNotice: () => null,
}));

const REACHED = { kind: "reached", used: 10, limit: 10 };
const WITHIN = { kind: "within", used: 1, limit: 10, remaining: 9 };

let container: HTMLElement;
let root: Root;

function render(props: Partial<ComponentProps<typeof DashboardAgentChat>>) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(DashboardAgentChat, {
        chatId: "chat_1",
        initialMessages: [],
        session: null,
        clientData: { userId: "user_1", organizationId: "org_1" },
        apiOrigin: "http://localhost",
        actionPath: "/resources/agent",
        projectName: "Proj",
        environmentSlug: "prod",
        watches: [],
        onCancelWatch: () => {},
        onTurnSettled: () => {},
        refusalGenRef: { current: 0 },
        onNewChat: () => {},
        showNewChat: false,
        ...props,
      }),
    },
  ]);
  act(() => root.render(createElement(RouterProvider, { router })));
}

describe("DashboardAgentChat turn errors", () => {
  beforeEach(() => {
    state.error = undefined;
    state.quota = { kind: "unlimited" };
    state.pollSeq = 0;
    state.sendMessage = vi.fn(async () => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("reports the SDK error when headless", () => {
    const onTurnError = vi.fn();
    state.error = new Error("The agent crashed.");
    render({ headless: true, onTurnError });
    expect(onTurnError).toHaveBeenCalledWith("The agent crashed.");
  });

  it("reports a send held at the message cap when headless", () => {
    const onTurnError = vi.fn();
    state.quota = REACHED;
    render({ headless: true, onTurnError, sendRequest: { text: "hi", seq: 1 } });
    expect(onTurnError).toHaveBeenCalledWith("You've reached your message limit.");
    expect(state.sendMessage).not.toHaveBeenCalled();
  });

  // Mutation: gating the cap-hold report on `headless` instead of `onTurnError` fails this.
  it("keeps a capped send waiting in edit mode and sends it once the cap lifts", () => {
    state.quota = REACHED;
    render({ headless: true, sendRequest: { text: "hi", seq: 1 } });
    expect(state.sendMessage).not.toHaveBeenCalled();
    state.quota = WITHIN;
    state.pollSeq = 1;
    render({ headless: true, sendRequest: { text: "hi", seq: 1 } });
    expect(state.sendMessage).toHaveBeenCalledWith({ text: "hi" });
  });

  // Mutation: dropping the `headless` gate on the error report fails this.
  it("does not report the SDK error when not headless", () => {
    const onTurnError = vi.fn();
    state.error = new Error("The agent crashed.");
    render({ onTurnError });
    expect(onTurnError).not.toHaveBeenCalled();
  });
});
