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
    expect(recover?.({ lastOutEventId: "9007199254740993", lastInEventId: "4" })).toBe(true);
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
    expect(recover?.({ lastOutEventId: "9007199254740994", lastInEventId: "4" })).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it.each([undefined, "", "NaN", "-1", "1e20", "9007199254740993x"])(
    "reports invalid output evidence and keeps sends blocked: %s",
    (lastOutEventId) => {
      const { transport, saved } = blockedTransport();
      const before = transport.getSession("chat-1");
      const recover = transport.prepareTranscriptRecovery("chat-1");
      expect(() => recover?.({ lastOutEventId, lastInEventId: "4" })).toThrow(
        "Transcript recovery requires numeric input and output cursors"
      );
      expect(transport.getSession("chat-1")).toEqual(before);
      expect(saved).toEqual([]);
    }
  );

  it.each(["9007199254740992", "42"])("rejects a stale output checkpoint: %s", (lastOutEventId) => {
    const { transport, saved } = blockedTransport();
    expect(
      transport.prepareTranscriptRecovery("chat-1")?.({ lastOutEventId, lastInEventId: "4" })
    ).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
    expect(saved).toEqual([]);
  });

  it("reports missing cursor evidence", () => {
    const { transport } = blockedTransport();
    expect(() => transport.prepareTranscriptRecovery("chat-1")?.(undefined)).toThrow(
      "Transcript recovery requires numeric input and output cursors"
    );
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it("rejects a malformed persisted cursor", () => {
    const { transport } = blockedTransport({ lastEventId: "invalid" });
    expect(
      transport.prepareTranscriptRecovery("chat-1")?.({
        lastOutEventId: "9007199254740993",
        lastInEventId: "4",
      })
    ).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it("recovers a session with no previous cursor", () => {
    const { transport } = blockedTransport({ lastEventId: undefined });
    expect(
      transport.prepareTranscriptRecovery("chat-1")?.({ lastOutEventId: "42", lastInEventId: "4" })
    ).toBe(true);
    expect(transport.getSession("chat-1")?.lastEventId).toBe("42");
  });

  it("does not seed a cursor after a superseded recovery fails", () => {
    const { transport } = blockedTransport({ lastEventId: undefined });
    const stale = transport.prepareTranscriptRecovery("chat-1");
    const current = transport.prepareTranscriptRecovery("chat-1");
    expect(stale?.({ lastOutEventId: "50", lastInEventId: "4" })).toBe(false);
    expect(transport.getSession("chat-1")?.lastEventId).toBeUndefined();
    expect(current?.({ lastOutEventId: "42", lastInEventId: "4" })).toBe(true);
  });

  it("rejects a load for a replaced session", () => {
    const { transport } = blockedTransport();
    const recover = transport.prepareTranscriptRecovery("chat-1");
    transport.setSession("chat-1", transport.getSession("chat-1")!);
    expect(recover?.({ lastOutEventId: "9007199254740993", lastInEventId: "4" })).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it("rejects a load after the cursor changes", () => {
    const { transport } = blockedTransport({ lastEventId: undefined });
    const recover = transport.prepareTranscriptRecovery("chat-1");
    transport.seedResumeCursor("chat-1", "42");
    expect(recover?.({ lastOutEventId: "43", lastInEventId: "4" })).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it.each(["abandon", "dispose"])("rejects a load after %s", (operation) => {
    const { transport } = blockedTransport();
    const recover = transport.prepareTranscriptRecovery("chat-1");
    if (operation === "abandon") transport.clearSupersedeGate("chat-1");
    else transport.dispose();
    expect(recover?.({ lastOutEventId: "9007199254740993", lastInEventId: "4" })).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
  });

  it.each([undefined, "", "NaN", "-1", "4x"])(
    "reports invalid input evidence and keeps sends blocked: %s",
    (lastInEventId) => {
      const { transport, saved } = blockedTransport({ lastEventId: undefined });
      const recover = transport.prepareTranscriptRecovery("chat-1");
      expect(() => recover?.({ lastOutEventId: "42", lastInEventId })).toThrow(
        "Transcript recovery requires numeric input and output cursors"
      );
      expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
      expect(saved).toEqual([]);
    }
  );

  it("rejects a stale input checkpoint", () => {
    const { transport, saved } = blockedTransport();
    expect(
      transport.prepareTranscriptRecovery("chat-1")?.({
        lastOutEventId: "9007199254740993",
        lastInEventId: "3",
      })
    ).toBe(false);
    expect(transport.getSession("chat-1")?.requiresTranscriptReload).toBe(true);
    expect(saved).toEqual([]);
  });

  it("rejects an obsolete callback before it examines missing evidence", () => {
    const { transport } = blockedTransport();
    const stale = transport.prepareTranscriptRecovery("chat-1");
    transport.prepareTranscriptRecovery("chat-1");
    expect(stale?.(undefined)).toBe(false);
  });

  it("keeps recovery blocked when the stopped input is unknown", () => {
    const { transport } = blockedTransport({
      lastEventId: undefined,
      supersededInputSeq: undefined,
    });
    const recover = transport.prepareTranscriptRecovery("chat-1");
    expect(() => recover?.({ lastOutEventId: "42", lastInEventId: "100" })).toThrow(
      "Transcript recovery requires a stopped input sequence"
    );
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

  it("preserves closed state on hydration but resets it on explicit replacement", () => {
    const { transport } = blockedTransport({ closed: true, closedReason: "finished" });
    const session = transport.getSession("chat-1")!;
    expect(session).toMatchObject({ closed: true, closedReason: "finished" });
    transport.setSession("chat-1", session);
    expect(transport.getSession("chat-1")).toMatchObject({
      closed: undefined,
      closedReason: undefined,
    });
    expect(transport.prepareTranscriptRecovery("chat-1")).toBeDefined();
  });
});
