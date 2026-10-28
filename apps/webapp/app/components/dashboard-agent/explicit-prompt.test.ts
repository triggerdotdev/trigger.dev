import { describe, expect, it } from "vitest";
import { explicitPromptTarget } from "./explicit-prompt";

describe("explicitPromptTarget", () => {
  it("starts a chat when the panel has none", () => {
    expect(explicitPromptTarget({ chat: "none", turnInFlight: false })).toBe("new-chat");
  });

  it("sends into the chat the user is already in", () => {
    expect(explicitPromptTarget({ chat: "open", turnInFlight: false })).toBe("send-to-open-chat");
  });

  it("holds while a chat is still opening, rather than racing it into a new one", () => {
    expect(explicitPromptTarget({ chat: "opening", turnInFlight: false })).toBe("hold");
  });

  it("holds while the open chat is mid-turn instead of barging in", () => {
    expect(explicitPromptTarget({ chat: "open", turnInFlight: true })).toBe("hold");
  });

  it("never fills the composer and leaves the sending to the user", () => {
    const targets = (["none", "opening", "open"] as const).flatMap((chat) =>
      [true, false].map((turnInFlight) => explicitPromptTarget({ chat, turnInFlight }))
    );
    expect(targets).not.toContain("prefill");
  });
});
