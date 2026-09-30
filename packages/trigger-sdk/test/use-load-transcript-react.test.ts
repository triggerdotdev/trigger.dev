// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useLoadTranscript, type LoadTranscriptResult } from "../src/v3/chat-react.js";
import { TriggerChatTransport, type ChatSessionPersistedState } from "../src/v3/chat.js";

type ProbeProps = {
  transport: TriggerChatTransport;
  load: (params: { chatId: string; limit?: number }) => Promise<LoadTranscriptResult>;
};

function Probe({ transport, load }: ProbeProps) {
  const result = useLoadTranscript("chat", load, { transport });
  return createElement(
    "output",
    {
      "data-status": result.isLoading ? "loading" : result.error ? "error" : "ready",
      "data-next-cursor": result.nextCursor,
    },
    result.error?.message ?? result.messages.map((message) => message.id).join(",")
  );
}

function pendingLoad() {
  let resolve!: (result: LoadTranscriptResult) => void;
  const promise = new Promise<LoadTranscriptResult>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function transcript(messageId = "saved-answer", lastOutEventId = "11"): LoadTranscriptResult {
  return {
    messages: [
      { id: messageId, role: "assistant", parts: [{ type: "text", text: "Saved answer" }] },
    ],
    cursors: { lastOutEventId, lastInEventId: "10" },
    nextCursor: "older-messages",
  };
}

describe("useLoadTranscript mounted recovery", () => {
  const mounted: Array<{ root: Root; container: HTMLDivElement; unmounted: boolean }> = [];
  const transports: TriggerChatTransport[] = [];
  const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

  beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      writable: true,
      value: true,
    });
  });

  afterEach(async () => {
    for (const view of mounted.splice(0)) {
      if (!view.unmounted) await act(async () => view.root.unmount());
      view.container.remove();
    }
    for (const transport of transports.splice(0)) transport.dispose();
  });

  afterAll(() => {
    if (actEnvironment) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    } else {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  });

  function blockedTransport() {
    const saved: ChatSessionPersistedState[] = [];
    const transport = new TriggerChatTransport({
      task: "chat-task",
      accessToken: () => "test-token",
      sessions: {
        chat: {
          publicAccessToken: "test-token",
          lastEventId: "1",
          supersededInputSeq: 10,
          skipToTurnComplete: true,
          requiresTranscriptReload: true,
          isStreaming: false,
        },
      },
      onSessionChange: (_chatId, session) => {
        if (session) saved.push(session);
      },
    });
    transports.push(transport);
    return { transport, saved };
  }

  async function mount(props: ProbeProps, strict = false) {
    const container = document.createElement("div");
    document.body.append(container);
    const view = { root: createRoot(container), container, unmounted: false };
    mounted.push(view);
    const render = async (next: ProbeProps) => {
      await act(async () => {
        const probe = createElement(Probe, next);
        view.root.render(strict ? createElement(StrictMode, null, probe) : probe);
      });
    };
    await render(props);
    return {
      container,
      render,
      async unmount() {
        await act(async () => view.root.unmount());
        view.unmounted = true;
      },
    };
  }

  it("renders the transcript and persists recovery after a valid load", async () => {
    const { transport, saved } = blockedTransport();
    const pending = pendingLoad();
    const view = await mount({ transport, load: () => pending.promise });

    expect(view.container.querySelector("output")?.dataset.status).toBe("loading");
    expect(transport.getSession("chat")?.requiresTranscriptReload).toBe(true);

    await act(async () => pending.resolve(transcript()));

    expect(view.container.querySelector("output")?.dataset.status).toBe("ready");
    expect(view.container.querySelector("output")?.dataset.nextCursor).toBe("older-messages");
    expect(view.container.textContent).toBe("saved-answer");
    expect(transport.getSession("chat")).toMatchObject({
      lastEventId: "11",
      requiresTranscriptReload: false,
      skipToTurnComplete: false,
    });
    expect(saved).toHaveLength(1);
  });

  it("ignores the first Strict Mode load and recovers from the current load", async () => {
    const { transport, saved } = blockedTransport();
    const loads: ReturnType<typeof pendingLoad>[] = [];
    const view = await mount(
      {
        transport,
        load: () => {
          const pending = pendingLoad();
          loads.push(pending);
          return pending.promise;
        },
      },
      true
    );
    expect(loads).toHaveLength(2);

    await act(async () => loads[0]!.resolve(transcript("cancelled-answer", "99")));
    expect(view.container.querySelector("output")?.dataset.status).toBe("loading");
    expect(transport.getSession("chat")?.requiresTranscriptReload).toBe(true);
    expect(saved).toEqual([]);

    await act(async () => loads[1]!.resolve(transcript("current-answer")));
    expect(view.container.textContent).toBe("current-answer");
    expect(transport.getSession("chat")?.lastEventId).toBe("11");
    expect(saved).toHaveLength(1);
  });

  it("does not recover after the component unmounts", async () => {
    const { transport, saved } = blockedTransport();
    const pending = pendingLoad();
    const view = await mount({ transport, load: () => pending.promise });
    await view.unmount();

    await act(async () => pending.resolve(transcript()));

    expect(view.container.textContent).toBe("");
    expect(transport.getSession("chat")).toMatchObject({
      lastEventId: "1",
      requiresTranscriptReload: true,
    });
    expect(saved).toEqual([]);
  });

  it("loads again for a replacement transport and ignores the previous result", async () => {
    const first = blockedTransport();
    const replacement = blockedTransport();
    const loads: ReturnType<typeof pendingLoad>[] = [];
    const load = () => {
      const pending = pendingLoad();
      loads.push(pending);
      return pending.promise;
    };
    const view = await mount({ transport: first.transport, load });
    await view.render({ transport: replacement.transport, load });
    expect(loads).toHaveLength(2);

    await act(async () => loads[0]!.resolve(transcript("previous-answer", "99")));
    expect(view.container.querySelector("output")?.dataset.status).toBe("loading");
    expect(first.saved).toEqual([]);
    expect(replacement.saved).toEqual([]);

    await act(async () => loads[1]!.resolve(transcript("replacement-answer")));
    expect(view.container.textContent).toBe("replacement-answer");
    expect(first.transport.getSession("chat")?.requiresTranscriptReload).toBe(true);
    expect(replacement.transport.getSession("chat")?.requiresTranscriptReload).toBe(false);
    expect(replacement.saved).toHaveLength(1);
  });

  it("reports a stale checkpoint and retains the send block", async () => {
    const { transport, saved } = blockedTransport();
    const loaded = transcript();
    loaded.cursors = { lastOutEventId: "11", lastInEventId: "9" };
    const view = await mount({ transport, load: async () => loaded });

    expect(view.container.querySelector("output")?.dataset.status).toBe("error");
    expect(view.container.textContent).toContain("not current");
    expect(transport.getSession("chat")?.requiresTranscriptReload).toBe(true);
    expect(saved).toEqual([]);
  });

  it("reports missing input evidence and retains the send block", async () => {
    const { transport, saved } = blockedTransport();
    const loaded = transcript();
    loaded.cursors = { lastOutEventId: "11" };
    const view = await mount({ transport, load: async () => loaded });

    expect(view.container.querySelector("output")?.dataset.status).toBe("error");
    expect(view.container.textContent).toMatch(/input/i);
    expect(transport.getSession("chat")?.requiresTranscriptReload).toBe(true);
    expect(saved).toEqual([]);
  });
});
