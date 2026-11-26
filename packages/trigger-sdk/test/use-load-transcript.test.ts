import { describe, expect, it } from "vitest";
import { TriggerChatTransport } from "../src/v3/chat.js";
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

  describe("with a send outstanding and no cursor", () => {
    // A send over a reply still running persists no cursor, so a reload finds where
    // its turn starts. A transcript saved before that send was answered ends before
    // the old reply, and reading from there would replay it into the new answer.
    it("leaves the cursor to the turn-start lookup when the transcript hasn't answered the send", () => {
      // Catches: the transcript's cursor filling the empty one either way.
      const transport = transportWithStart();

      transport.setSession("chat-1", {
        publicAccessToken: "pat",
        activeInputSeq: 5,
        isStreaming: true,
      });
      seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "14", lastInEventId: "4" });

      expect(transport.getSession("chat-1")?.lastEventId).toBeUndefined();
    });

    it("takes the cursor of a transcript saved after the send was answered", () => {
      // Catches: refusing it there too, which replays the finished reply on top of
      // the transcript that holds it.
      const transport = transportWithStart();

      transport.setSession("chat-1", {
        publicAccessToken: "pat",
        activeInputSeq: 5,
        isStreaming: true,
      });
      seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "14", lastInEventId: "5" });

      expect(transport.getSession("chat-1")?.lastEventId).toBe("14");
    });

    it("takes the cursor of a transcript that carries no `.in` cursor, as before", () => {
      // Catches: refusing a cursor the transport can't place: with no `.in` cursor
      // there is no telling whether the send was answered.
      const transport = transportWithStart();

      transport.setSession("chat-1", {
        publicAccessToken: "pat",
        activeInputSeq: 5,
        isStreaming: true,
      });
      seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "14" });

      expect(transport.getSession("chat-1")?.lastEventId).toBe("14");
    });

    it("takes the cursor for a session restored mid-turn with no `.in` seq", () => {
      // Catches: treating a streaming session as a send outstanding: without the
      // send's seq there is no lookup to leave it to.
      const transport = transportWithStart();

      transport.setSession("chat-1", { publicAccessToken: "pat", isStreaming: true });
      seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "14", lastInEventId: "4" });

      expect(transport.getSession("chat-1")?.lastEventId).toBe("14");
    });

    it("decides a cursor seeded before the session is restored the same way", () => {
      // Catches: the pending path applying the cursor without the check.
      const transport = transportWithStart();

      seedTranscriptCursor(transport, "chat-1", { lastOutEventId: "14", lastInEventId: "4" });
      transport.setSession("chat-1", {
        publicAccessToken: "pat",
        activeInputSeq: 5,
        isStreaming: true,
      });

      expect(transport.getSession("chat-1")?.lastEventId).toBeUndefined();
    });
  });
});
