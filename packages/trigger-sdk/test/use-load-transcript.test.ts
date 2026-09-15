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
});
