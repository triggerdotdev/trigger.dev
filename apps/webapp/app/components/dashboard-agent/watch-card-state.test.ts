import type { WatchDraft } from "@internal/dashboard-agent-contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NO_WATCH_CARD, watchCardReducer, type WatchCardState } from "./watch-card-state";

const draftFor = (note: string): WatchDraft =>
  ({
    spec: { kind: "error_recurrence", fingerprint: note, checkEveryMinutes: 15, maxHours: 6, note },
    followUp: { investigateOnAttention: false, notifyExternally: false },
  }) as WatchDraft;

const run = (events: Parameters<typeof watchCardReducer>[1][], from = NO_WATCH_CARD) =>
  events.reduce<WatchCardState>(watchCardReducer, from);

const opened = () => run([{ type: "open", draft: draftFor("the TypeError"), requestId: "wreq_1" }]);

describe("a watch card belongs to the chat it was configured in", () => {
  it("abandons a half-configured card when the chat changes", () => {
    expect(run([{ type: "chat-changed" }], opened())).toEqual(NO_WATCH_CARD);
  });

  it("lets go of the request id too, so the next card writes its own records", () => {
    const afterFailure = run(
      [
        { type: "submitting", requestId: "wreq_1" },
        { type: "failed", error: "nope" },
      ],
      opened()
    );
    expect(afterFailure.requestId).toBe("wreq_1");
    expect(run([{ type: "chat-changed" }], afterFailure).requestId).toBeUndefined();
  });

  it("abandons a card that was mid-submit when the chat changed", () => {
    const submitting = run([{ type: "submitting", requestId: "wreq_1" }], opened());
    expect(submitting.pending).toBe(true);
    expect(run([{ type: "chat-changed" }], submitting)).toEqual(NO_WATCH_CARD);
  });

  it("clears the card once it has been submitted", () => {
    expect(run([{ type: "submitted" }], opened())).toEqual(NO_WATCH_CARD);
    expect(run([{ type: "dismissed" }], opened())).toEqual(NO_WATCH_CARD);
  });
});

describe("the request id survives a retry", () => {
  it("keeps the id it was opened with across a failed submit", () => {
    const retried = run(
      [
        { type: "submitting", requestId: "wreq_1" },
        { type: "failed", error: "nope" },
        { type: "submitting", requestId: "wreq_2" },
      ],
      opened()
    );
    // A resubmit repairs the same server records; a fresh id would write a second pair.
    expect(retried.requestId).toBe("wreq_1");
    expect(retried.error).toBeNull();
    expect(retried.pending).toBe(true);
  });

  it("keeps the edited draft, and edits nothing once the card is gone", () => {
    const edited = run([{ type: "edit", draft: draftFor("edited") }], opened());
    expect(edited.draft).toEqual(draftFor("edited"));
    expect(edited.requestId).toBe("wreq_1");
    expect(run([{ type: "edit", draft: draftFor("edited") }])).toEqual(NO_WATCH_CARD);
  });

  it("opening a second card starts clean", () => {
    const reopened = run(
      [
        { type: "failed", error: "nope" },
        { type: "open", draft: draftFor("another"), requestId: "wreq_2" },
      ],
      opened()
    );
    expect(reopened).toEqual({
      draft: draftFor("another"),
      requestId: "wreq_2",
      pending: false,
      error: null,
    });
  });
});

/**
 * Structural guard, not behavioural proof: the reducer only sees a chat change if every path
 * that changes chat routes through `claimChatSlot`, which is also the only place the in-flight
 * open sequence is bumped.
 */
describe("every chat change goes through one door", () => {
  const panel = readFileSync(new URL("./DashboardAgentPanel.tsx", import.meta.url), "utf8");

  it("bumps the open sequence in exactly one place, next to the card reset", () => {
    const bumps = panel.match(/openChatRequestSeq\.current\s*(\+\+|\+=)|\+\+openChatRequestSeq/g);
    expect(bumps).toHaveLength(1);
    const claim = panel.slice(
      panel.indexOf("const claimChatSlot = useCallback(() => {"),
      panel.indexOf("const openChat = useCallback(")
    );
    // Whitespace-tolerant: the formatter is free to reindent or rewrap the call.
    expect(claim).toMatch(/dispatchWatchCard\(\{\s*type:\s*"chat-changed",?\s*\}\);/);
    expect(claim).toContain("return ++openChatRequestSeq.current;");
  });

  it("claims a slot before every setActive that lands in a different chat", () => {
    for (const caller of ["openChat", "createChat", "newChat", "submitWatch"]) {
      expect(panel).toMatch(new RegExp(`const ${caller} = useCallback\\(`));
    }
    // The watch's own landing chat: without the claim, an earlier open still matches its seq.
    const submit = panel.slice(panel.indexOf("const submitWatch = useCallback("));
    const claim = submit.indexOf("claimChatSlot();");
    // Whitespace-tolerant: the formatter is free to wrap the call across lines.
    const setActive = submit.search(/setActive\(\{\s*chatId:\s*data\.chatId/);
    expect(claim).toBeGreaterThan(-1);
    expect(setActive).toBeGreaterThan(claim);
  });

  it("leaves no separate watch-draft state for a chat change to miss", () => {
    expect(panel).not.toContain("setWatchDraft");
    expect(panel).not.toContain("watchRequestId");
  });
});
