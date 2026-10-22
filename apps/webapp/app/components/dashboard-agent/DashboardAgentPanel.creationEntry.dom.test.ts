// @vitest-environment jsdom
import { createElement, useEffect, useState, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentPanel } from "./DashboardAgentPanel";
import { alertName, type DraftPrefillParams } from "./alert-creation/flow-state";
import type { ToolResultPayload } from "./alert-creation/draftPatch";

type SeenChat = {
  chatId: string;
  sendRequest?: { text: string; chatId: string };
  onAlertDraftPatch?: (results: ToolResultPayload[]) => void;
  onCreationTextReply?: (text: string) => void;
  onTurnError?: (message: string) => void;
};

const seen = vi.hoisted(() => ({
  chats: [] as SeenChat[],
  onFreeText: undefined as ((text: string) => void) | undefined,
  systemLines: [] as Array<{ text: string; variant: string }>,
  answers: undefined as Record<string, unknown> | undefined,
  step: undefined as string | undefined,
  manual: undefined as boolean | undefined,
  addChannel: undefined as Record<string, unknown> | undefined,
  setPrefill: undefined as ((prefill: unknown) => void) | undefined,
  flow: undefined as
    | { patchAnswers: (answers: Record<string, unknown>) => void; create: () => void }
    | undefined,
}));

vi.mock("./DashboardAgentChat", () => ({
  DashboardAgentChat: (props: SeenChat) => {
    seen.chats.push(props);
    return null;
  },
}));
vi.mock("~/components/alerts/CreationTranscript", () => ({
  CreationTranscript: (props: {
    onFreeText: (text: string) => void;
    systemLines: Array<{ text: string; variant: string }>;
    flow: NonNullable<typeof seen.flow> & {
      answers: Record<string, unknown>;
      currentStep?: string;
    };
    addChannel: Record<string, unknown>;
    manual: boolean;
  }) => {
    seen.manual = props.manual;
    seen.step = props.flow.currentStep;
    seen.addChannel = props.addChannel;
    seen.flow = props.flow;
    seen.onFreeText = props.onFreeText;
    seen.systemLines = props.systemLines;
    seen.answers = props.flow.answers;
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
let router: ReturnType<typeof createMemoryRouter>;
let createdSessions = 0;
let withPrefill = true;
let release: (() => void) | undefined;
let failCreate = false;
let failOpen = false;

function stubFetch(hold?: "create-session" | "open" | "alert-create") {
  createdSessions = 0;
  release = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const intent = (init?.body as FormData | undefined)?.get?.("intent") as string | undefined;
      const isOpen = String(input).includes("chatId=chat_");
      const isAlertCreate = String(input).includes("/resources/alerts/create");
      if (
        hold &&
        (intent === hold ||
          (hold === "open" && isOpen) ||
          (hold === "alert-create" && isAlertCreate))
      ) {
        hold = undefined;
        await new Promise<void>((resolve) => (release = resolve));
      }
      if (intent === "create-session") {
        createdSessions++;
        return new Response(JSON.stringify({ chatId: `chat_${createdSessions}` }));
      }
      if (isAlertCreate && failCreate) return new Response("{}", { status: 500 });
      if (isOpen && failOpen) return new Response("{}", { status: 500 });
      if (isOpen) {
        return new Response(
          JSON.stringify({ messages: [], session: { publicAccessToken: "tok" } })
        );
      }
      return new Response(JSON.stringify({ chats: [], channels: [] }));
    })
  );
}

function Host() {
  const [prefill, setPrefill] = useState<DraftPrefillParams>({ area: "queues" });
  useEffect(() => {
    seen.setPrefill = setPrefill as (prefill: unknown) => void;
  }, []);
  return createElement(DashboardAgentPanel, {
    onClose: () => {},
    openSource: "alerts",
    createAlertPrefill: withPrefill ? prefill : undefined,
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

async function render(entry = "/") {
  router = createMemoryRouter(
    [
      {
        path: "/",
        element: createElement(
          OperatingSystemContextProvider,
          { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
          createElement(ShortcutsProvider, null, createElement(Host))
        ),
      },
      { path: "/resources/alerts/channels", loader: () => ({ channels: [] }) },
    ],
    { initialEntries: [entry] }
  );
  await act(async () => root.render(createElement(RouterProvider, { router })));
  await flush();
}

async function send(text: string) {
  await act(async () => seen.onFreeText!(text));
  await flush();
}

async function changePrefill() {
  await act(async () => seen.setPrefill!({ area: "runs" }));
  await flush();
}

async function releaseHeld() {
  await act(async () => release!());
  await flush();
}

async function submit(answers: Record<string, unknown>) {
  await act(async () => seen.flow!.patchAnswers(answers));
  await act(async () => {
    void seen.flow!.create();
  });
  await flush();
}

function posted(intent: string) {
  return vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => init?.body)
    .filter((body): body is FormData => body instanceof FormData && body.get("intent") === intent)
    .map((body) => ({ chatId: body.get("chatId"), title: body.get("title") }));
}

const ANSWERS_A = {
  area: "queues",
  what: "queue.depth",
  scope: "all",
  condition: "100",
  windowMinutes: 5,
  notifiers: [],
  expiry: "never",
};
const ANSWERS_B = { ...ANSWERS_A, condition: "200" };

function sentTexts() {
  return seen.chats.flatMap((chat) => (chat.sendRequest ? [chat.sendRequest.text] : []));
}

describe("DashboardAgentPanel creation entries", () => {
  beforeEach(() => {
    seen.chats = [];
    seen.onFreeText = undefined;
    seen.systemLines = [];
    seen.answers = undefined;
    withPrefill = true;
    failCreate = false;
    failOpen = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // Mutation: dropping the generation bump on prefill change fails this.
  it("starts a fresh chat when the prefill changes", async () => {
    stubFetch();
    await render();
    await send("first");
    expect(seen.chats.at(-1)?.sendRequest).toMatchObject({ text: "first", chatId: "chat_1" });

    await changePrefill();
    await send("second");

    expect(createdSessions).toBe(2);
    expect(seen.chats.at(-1)?.sendRequest).toMatchObject({ text: "second", chatId: "chat_2" });
  });

  // Mutation: dropping the generation bump on URL-key change fails this.
  it("starts a fresh chat when the create URL changes", async () => {
    withPrefill = false;
    stubFetch();
    await render();
    await send("first");
    expect(seen.chats.at(-1)?.sendRequest).toMatchObject({ text: "first", chatId: "chat_1" });

    await act(async () => router.navigate("/?create=1&area=runs"));
    await flush();
    await send("second");

    expect(createdSessions).toBe(2);
    expect(seen.chats.at(-1)?.sendRequest).toMatchObject({ text: "second", chatId: "chat_2" });
  });

  // Mutation: dropping the entry guard on the creation callbacks fails this.
  it("drops a reply from the previous entry's turn", async () => {
    stubFetch();
    await render();
    await send("first");
    await changePrefill();
    expect(seen.answers).toMatchObject({ area: "runs" });
    const lines = seen.systemLines;

    const old = seen.chats.at(-1)!;
    expect(old.chatId).toBe("chat_1");
    await act(async () => {
      old.onAlertDraftPatch!([{ ok: true, patch: { area: "errors" } }]);
      old.onCreationTextReply!("old reply");
      old.onTurnError!("old error");
    });

    expect(seen.answers).toMatchObject({ area: "runs" });
    expect(seen.systemLines).toEqual(lines);
  });

  // Mutation: making the entry guard always drop fails this.
  it("applies the new entry's own reply", async () => {
    stubFetch();
    await render();
    await send("first");
    await changePrefill();
    await send("second");

    const current = seen.chats.at(-1)!;
    expect(current.chatId).toBe("chat_2");
    await act(async () => {
      current.onAlertDraftPatch!([{ ok: true, patch: { area: "errors" } }]);
      current.onCreationTextReply!("new reply");
    });

    expect(seen.answers).toMatchObject({ area: "errors" });
    expect(seen.systemLines.at(-1)).toMatchObject({ variant: "reply", text: "new reply" });
  });

  // Mutation: dropping the entry check after ensure() fails this.
  it("abandons a send whose chat is still being created when the entry changes", async () => {
    stubFetch("create-session");
    await render();
    await act(async () => seen.onFreeText!("first"));
    await changePrefill();
    await releaseHeld();

    expect(seen.systemLines).toEqual([]);
    expect(sentTexts()).not.toContain("first");
  });

  // Mutation: dropping the entry check after openChat() fails this.
  it("abandons a send whose chat is still opening when the entry changes", async () => {
    stubFetch("open");
    await render();
    await send("first");
    await changePrefill();
    await releaseHeld();

    expect(seen.systemLines).toEqual([]);
    expect(sentTexts()).not.toContain("first");
  });

  // Mutation: renaming from shared state or gating the rename on the entry fails this.
  it("renames each entry's chat with its own alert name", async () => {
    stubFetch("alert-create");
    await render();
    await submit(ANSWERS_A);
    await changePrefill();
    await submit(ANSWERS_B);
    await releaseHeld();

    expect(alertName(ANSWERS_A)).not.toBe(alertName(ANSWERS_B));
    expect(posted("rename")).toEqual([
      { chatId: "chat_2", title: alertName(ANSWERS_B) },
      { chatId: "chat_1", title: alertName(ANSWERS_A) },
    ]);
  });

  // Mutation: not keeping the session before the create await fails this.
  it("keeps the transcript chat of a create still in flight when the entry changes", async () => {
    stubFetch("alert-create");
    await render();
    await submit(ANSWERS_A);
    expect(createdSessions).toBe(1);
    await changePrefill();

    expect(posted("delete")).not.toContainEqual(expect.objectContaining({ chatId: "chat_1" }));
    await releaseHeld();
    expect(posted("delete")).not.toContainEqual(expect.objectContaining({ chatId: "chat_1" }));
  });

  // Mutation: releasing the create's hold after a success fails this.
  it("keeps the transcript chat of a create that succeeds after the panel unmounts", async () => {
    stubFetch("alert-create");
    await render();
    await submit(ANSWERS_A);
    act(() => root.unmount());
    await releaseHeld();

    expect(posted("delete")).not.toContainEqual(expect.objectContaining({ chatId: "chat_1" }));
  });

  // Mutation: not releasing the chat after a failed create fails this.
  it("discards the transcript chat of a failed create when the entry changes", async () => {
    failCreate = true;
    stubFetch("alert-create");
    await render();
    await submit(ANSWERS_A);
    await releaseHeld();
    expect(posted("delete")).toEqual([]);
    await changePrefill();

    expect(posted("delete")).toContainEqual(expect.objectContaining({ chatId: "chat_1" }));
  });

  // Mutation: dropping the discard when the last owner releases a detached chat fails this.
  it("discards the transcript chat of a create that fails after the panel unmounts", async () => {
    failCreate = true;
    stubFetch("alert-create");
    await render();
    await submit(ANSWERS_A);
    act(() => root.unmount());
    expect(posted("delete")).toEqual([]);
    await releaseHeld();

    expect(posted("delete")).toContainEqual(expect.objectContaining({ chatId: "chat_1" }));
  });

  // Mutation: letting a failed create's release drop the composer's keep fails this.
  it("keeps a chat the user sent into when the pending create fails", async () => {
    failCreate = true;
    stubFetch("alert-create");
    await render();
    await submit(ANSWERS_A);
    await send("hello");
    expect(sentTexts()).toContain("hello");
    await releaseHeld();
    await changePrefill();

    expect(posted("delete")).not.toContainEqual(expect.objectContaining({ chatId: "chat_1" }));
  });

  // Mutation: dropping the release after a failed open fails this.
  it("discards a composer chat that failed to open when the entry changes", async () => {
    failOpen = true;
    stubFetch();
    await render();
    await send("first");
    expect(posted("delete")).toEqual([]);
    await changePrefill();

    expect(posted("delete")).toContainEqual(expect.objectContaining({ chatId: "chat_1" }));
  });

  it("keeps a composer chat that opened when the entry changes", async () => {
    stubFetch();
    await render();
    await send("first");
    await changePrefill();

    expect(posted("delete")).not.toContainEqual(expect.objectContaining({ chatId: "chat_1" }));
  });

  // Mutation: dropping the Slack resume restore fails this.
  it("resumes on the notifiers step with the answers kept after connecting Slack", async () => {
    const answers = { ...ANSWERS_A, notifiers: ["ch_1"], expiry: "none" };
    sessionStorage.setItem("alerts.slackConnectResume.proj_1.env_1", JSON.stringify(answers));
    stubFetch();
    await render("/?create=1&add=slack&page=2");

    expect(seen.answers).toMatchObject(answers);
    expect(seen.step).toBe("notifiers");
    expect(seen.addChannel).toMatchObject({
      resumed: true,
      connectReturnTo: "/orgs/org/projects/proj/env/prod/alerts?create=1&add=slack",
    });
    expect(sessionStorage.getItem("alerts.slackConnectResume.proj_1.env_1")).toBeNull();
    expect(router.state.location.search).toBe("?page=2");
  });

  // Mutation: ignoring the manual flag on restore fails this.
  it("resumes in the manual form when the Slack connect started there", async () => {
    const answers = { ...ANSWERS_A, notifiers: ["ch_1"], expiry: "none" };
    sessionStorage.setItem(
      "alerts.slackConnectResume.proj_1.env_1",
      JSON.stringify({ ...answers, manual: true })
    );
    stubFetch();
    await render("/?create=1&add=slack&page=2");

    expect(seen.manual).toBe(true);
    expect(seen.answers).toMatchObject(answers);
    expect(seen.answers).not.toHaveProperty("manual");
  });

  // Mutation: dropping the panel-level consume fails this.
  it("stops resuming the Slack dialog once it has been dismissed", async () => {
    sessionStorage.setItem("alerts.slackConnectResume.proj_1.env_1", JSON.stringify(ANSWERS_A));
    stubFetch();
    await render("/?create=1&add=slack");
    expect(seen.addChannel).toMatchObject({ resumed: true });

    await act(async () => (seen.addChannel!.onResumeConsumed as () => void)());

    expect(seen.addChannel).toMatchObject({ resumed: false });
  });
});
