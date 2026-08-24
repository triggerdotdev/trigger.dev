import { describe, expect, it } from "vitest";
import { markerAfterActiveChat, markerAfterActivity } from "./thinking-marker";

describe("thinking marker", () => {
  it("marks the chat that is working and clears it when the turn settles", () => {
    const working = markerAfterActivity(null, "chat_1", "working");
    expect(working).toBe("chat_1");
    expect(markerAfterActivity(working, "chat_1", null)).toBe(null);
  });

  it("ignores a settled report from another chat", () => {
    expect(markerAfterActivity("chat_1", "chat_2", null)).toBe("chat_1");
  });

  it("clears the marker when the user switches away mid-turn", () => {
    // The streaming chat unmounts without reporting null, so only the switch clears it.
    expect(markerAfterActiveChat("chat_1", "chat_2")).toBe(null);
    expect(markerAfterActiveChat("chat_1", undefined)).toBe(null);
  });

  it("keeps the marker the chat just reported for itself", () => {
    expect(markerAfterActiveChat("chat_1", "chat_1")).toBe("chat_1");
  });
});
