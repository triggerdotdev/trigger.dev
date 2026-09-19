import { describe, expect, it } from "vitest";
import { TriggerChatTransport, type ChatSessionPersistedState } from "../src/v3/chat.js";
import { seedTranscriptCursor } from "../src/v3/chat-react.js";

function transportWithStart() {
  return new TriggerChatTransport({
    task: "my-chat",
    accessToken: () => "pat",
    startSession: async () => ({ publicAccessToken: "pat-from-start" }),
  });
}

describe("seedTranscriptCursor + TriggerChatTransport resume cursor", () => {
  it("does nothing when the transcript carries no cursor", () => {
    const transport = transportWithStart();

    expect(seedTranscriptCursor(transport, "chat-1", undefined)).toBe(false);
    expect(seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "" })).toBe(false);
    expect(transport.getSession("chat-1")).toBeUndefined();
  });

  it("holds a seeded cursor until the session is created, then applies it", async () => {
    const transport = transportWithStart();

    expect(seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "42" })).toBe(true);
    expect(transport.getSession("chat-1")).toBeUndefined();

    await transport.start("chat-1");
    expect(transport.getSession("chat-1")?.lastEventId).toBe("42");
  });

  it("applies a seeded cursor immediately when the session exists without one", async () => {
    const transport = transportWithStart();

    await transport.start("chat-1");
    seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "99" });

    expect(transport.getSession("chat-1")?.lastEventId).toBe("99");
  });

  it("consumes a pending cursor when setSession creates the session state", () => {
    const transport = transportWithStart();

    seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "42" });
    transport.setSession("chat-1", { publicAccessToken: "pat" });

    expect(transport.getSession("chat-1")?.lastEventId).toBe("42");
  });

  it("does not move an existing cursor backward", () => {
    const transport = transportWithStart();

    transport.setSession("chat-1", { publicAccessToken: "pat", lastEventId: "50" });
    seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "14" });

    expect(transport.getSession("chat-1")?.lastEventId).toBe("50");
  });
});

describe("transcript recovery", () => {
  function blockedTransport(overrides: Partial<ChatSessionPersistedState> = {}) {
    const saved: ChatSessionPersistedState[] = [];
    const transport = new TriggerChatTransport({
      task: "my-chat",
      accessToken: () => "pat",
      sessions: {
        "chat-1": {
          publicAccessToken: "pat",
          lastEventId: "9007199254740992",
          isStreaming: false,
          skipToTurnComplete: true,
          supersededInputSeq: 4,
          requiresTranscriptReload: true,
          ...overrides,
        },
      },
      onSessionChange: (_chatId, session) => {
        if (session) saved.push(session);
      },
    });
    return { transport, saved };
  }

  it("installs a newer checkpoint and persists recovery once", () => {
    const { transport, saved } = blockedTransport();
    const recover = transport.prepareTranscriptRecovery("chat-1");
    expect(recover).toBeDefined();
    expect(
      seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "9007199254740993" }, recover)
    ).toBe(true);
    expect(transport.getSession("chat-1")).toMatchObject({
      lastEventId: "9007199254740993",
      requiresTranscriptReload: false,
      skipToTurnComplete: false,
      supersededInputSeq: undefined,
      activeInputSeq: undefined,
      outstandingTurnAbandoned: false,
      skipSettledPeek: true,
      isStreaming: undefined,
    });
    expect(saved).toHaveLength(1);
    expect(recover?.("9007199254740994")).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it.each([undefined, "", "NaN", "-1", "1e20", "9007199254740993x", "9007199254740992", "42"])(
    "keeps sends blocked for an invalid or stale checkpoint: %s",
    (lastOutEventId) => {
      const { transport, saved } = blockedTransport();
      const before = transport.getSession("chat-1");
      const recover = transport.prepareTranscriptRecovery("chat-1");
      expect(seedTranscriptCursor(transport, "chat-1", { lastOutEventId }, recover)).toBe(false);
      expect(transport.getSession("chat-1")).toEqual(before);
      expect(saved).toEqual([]);
    }
  );

  it("rejects a malformed persisted cursor", () => {
    const { transport } = blockedTransport({ lastEventId: "invalid" });
    expect(transport.prepareTranscriptRecovery("chat-1")?.("9007199254740993")).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it("recovers a session with no previous cursor", () => {
    const { transport } = blockedTransport({ lastEventId: undefined });
    expect(transport.prepareTranscriptRecovery("chat-1")?.("42")).toBe(true);
    expect(transport.getSession("chat-1")?.lastEventId).toBe("42");
  });

  it("does not seed a cursor after a superseded recovery fails", () => {
    const { transport } = blockedTransport({ lastEventId: undefined });
    const stale = transport.prepareTranscriptRecovery("chat-1");
    const current = transport.prepareTranscriptRecovery("chat-1");
    expect(seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "50" }, stale)).toBe(false);
    expect(transport.getSession("chat-1")?.lastEventId).toBeUndefined();
    expect(seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "42" }, current)).toBe(true);
  });

  it("rejects a load for a replaced session", () => {
    const { transport } = blockedTransport();
    const recover = transport.prepareTranscriptRecovery("chat-1");
    transport.setSession("chat-1", transport.getSession("chat-1")!);
    expect(recover?.("9007199254740993")).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it("rejects a load after the cursor changes", () => {
    const { transport } = blockedTransport({ lastEventId: undefined });
    const recover = transport.prepareTranscriptRecovery("chat-1");
    transport.seedResumeCursor("chat-1", "42");
    expect(recover?.("43")).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it.each(["abandon", "dispose"])("rejects a load after %s", (operation) => {
    const { transport } = blockedTransport();
    const recover = transport.prepareTranscriptRecovery("chat-1");
    if (operation === "abandon") transport.clearSupersedeGate("chat-1");
    else transport.dispose();
    expect(recover?.("9007199254740993")).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it("does not prepare recovery for an ordinary load or a closed session", () => {
    const ordinary = blockedTransport({ requiresTranscriptReload: false }).transport;
    expect(ordinary.prepareTranscriptRecovery("chat-1")).toBeUndefined();
    const closed = blockedTransport({ closed: true }).transport;
    expect(closed.prepareTranscriptRecovery("chat-1")).toBeUndefined();
    expect(closed.getSession("chat-1")?.closed).toBe(true);
    expect(closed.prepareTranscriptRecovery("unknown")).toBeUndefined();
  });
});
