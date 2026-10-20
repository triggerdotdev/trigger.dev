// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCreationSession,
  type CreationSessionDeps,
  type CreationSession,
} from "./useCreationSession";

let container: HTMLElement;
let root: Root;
const capture = { session: undefined as CreationSession | undefined };

function Harness(props: CreationSessionDeps) {
  const session = useCreationSession(props);
  // eslint-disable-next-line -- test harness captures hook return
  capture.session = session;
  return null;
}

function latest(): CreationSession {
  return capture.session!;
}

function render(props: CreationSessionDeps) {
  act(() => {
    root.render(createElement(Harness, props));
  });
}

describe("useCreationSession", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Mutation: creating in an effect on enable (the old eager session) fails this.
  it("opening creation mode creates no chat", async () => {
    const createSession = vi.fn(async () => "chat_1");
    render({ enabled: true, createSession, discardSession: vi.fn() });
    await act(async () => {});
    expect(createSession).not.toHaveBeenCalled();
    expect(latest().chatId).toBeUndefined();
  });

  it("ensure creates exactly one chat, even when asked twice", async () => {
    const createSession = vi.fn(async () => "chat_1");
    render({ enabled: true, createSession, discardSession: vi.fn() });
    let ids: (string | undefined)[] = [];
    await act(async () => {
      ids = await Promise.all([latest().ensure(), latest().ensure()]);
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(["chat_1", "chat_1"]);
    expect(latest().chatId).toBe("chat_1");
  });

  it("a new generation drops an unkept chat and creates nothing", async () => {
    const createSession = vi.fn(async () => "chat_g1");
    const discardSession = vi.fn();
    render({ enabled: true, createSession, discardSession, generation: 0 });
    await act(async () => {
      await latest().ensure();
    });
    render({ enabled: true, createSession, discardSession, generation: 1 });
    expect(discardSession).toHaveBeenCalledWith("chat_g1");
    expect(latest().chatId).toBeUndefined();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled", async () => {
    const createSession = vi.fn(async () => "chat_1");
    render({ enabled: false, createSession, discardSession: vi.fn() });
    let id: string | undefined = "x";
    await act(async () => {
      id = await latest().ensure();
    });
    expect(id).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keeps the chat after keep()", async () => {
    const createSession = vi.fn(async () => "chat_3");
    const discardSession = vi.fn();
    render({ enabled: true, createSession, discardSession });
    await act(async () => {
      await latest().ensure();
    });
    act(() => latest().keep());
    render({ enabled: false, createSession, discardSession });
    expect(discardSession).not.toHaveBeenCalled();
  });

  it("discards a chat that lands after the session moved on", async () => {
    let resolve!: (v: string) => void;
    const createSession = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const discardSession = vi.fn();
    render({ enabled: true, createSession, discardSession, generation: 0 });
    let pending: Promise<string | undefined> | undefined;
    act(() => {
      pending = latest().ensure();
    });
    render({ enabled: true, createSession, discardSession, generation: 1 });
    await act(async () => {
      resolve("chat_stale");
      await pending;
    });
    expect(discardSession).toHaveBeenCalledWith("chat_stale");
    expect(latest().chatId).toBeUndefined();
  });

  it("retries after a failed create instead of reusing the settled promise", async () => {
    const calls: number[] = [];
    const createSession = async () => {
      calls.push(calls.length + 1);
      if (calls.length === 1) throw new Error("boom");
      return "chat_retry";
    };
    render({ enabled: true, createSession, discardSession: () => {} });
    let first: string | undefined = "x";
    let second: string | undefined;
    await act(async () => {
      first = await latest().ensure();
    });
    await act(async () => {
      second = await latest().ensure();
    });
    expect(first).toBeUndefined();
    expect(second).toBe("chat_retry");
    expect(calls).toHaveLength(2);
  });
});
