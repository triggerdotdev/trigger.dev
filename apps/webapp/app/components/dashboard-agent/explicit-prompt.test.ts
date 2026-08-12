import { readFileSync } from "node:fs";
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

/**
 * Structural guards, not behavioural proof: whether a held request is asked again, and whether
 * the old prefill path is really gone, live in the wiring rather than in the rule.
 */
describe("the panel sends every explicit prompt", () => {
  const panel = readFileSync(new URL("./DashboardAgentPanel.tsx", import.meta.url), "utf8");
  const chat = readFileSync(new URL("./DashboardAgentChat.tsx", import.meta.url), "utf8");

  it("routes through the shared rule", () => {
    expect(panel).toContain("explicitPromptTarget({");
  });

  it("keeps a held request pending instead of marking it handled", () => {
    const effect = panel.slice(panel.indexOf("const target = explicitPromptTarget({"));
    expect(effect.indexOf('if (target === "hold") return;')).toBeLessThan(
      effect.indexOf("handledRequestSeq.current = requestedMessage.seq;")
    );
  });

  it("re-asks once the panel settles, so a hold cannot strand the prompt", () => {
    expect(panel).toContain("}, [requestedMessage, loading, active, thinkingChatId, createChat]);");
  });

  it("leaves no prefill path behind", () => {
    expect(panel).not.toMatch(/prefill/i);
    expect(chat).not.toMatch(/prefill/i);
  });

  it("carries a first prompt on the new chat itself, not on a request that a switch clears", () => {
    const effect = panel.slice(panel.indexOf("const target = explicitPromptTarget({"));
    expect(effect.indexOf("void createChat(requestedMessage.text);")).toBeLessThan(
      effect.indexOf("setSendRequest({ ...requestedMessage")
    );
    expect(panel).toContain("pendingFirstMessage: data.headStarted ? undefined : text,");
  });

  it("drops the request when the chat slot changes, so switching back cannot re-send it", () => {
    const claim = panel.slice(
      panel.indexOf("const claimChatSlot = useCallback(() => {"),
      panel.indexOf("const openChat = useCallback(")
    );
    expect(claim).toContain("setSendRequest(undefined);");
  });

  it("submits the request in the chat rather than typing it into the composer", () => {
    expect(chat).toContain("submit(sendRequest.text);");
    expect(chat).not.toContain("setInput(sendRequest.text)");
  });
});
