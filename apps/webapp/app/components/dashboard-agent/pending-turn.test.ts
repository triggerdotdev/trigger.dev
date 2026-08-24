import { describe, expect, it } from "vitest";
import { nextPendingTurnChatId } from "./pending-turn";
import { shouldPollWakeFeed } from "./watch-activity";

/**
 * The launcher dot only appears if the wake poll is running when the answer lands. A turn
 * started in the panel has to keep the poll alive across a close, and let go of it once the
 * answer has been seen.
 */
describe("nextPendingTurnChatId", () => {
  it("latches onto the chat whose turn started", () => {
    expect(nextPendingTurnChatId(null, { chatId: "chat_a", active: true })).toBe("chat_a");
  });

  it("holds while a newer turn takes over", () => {
    const afterA = nextPendingTurnChatId(null, { chatId: "chat_a", active: true });
    expect(nextPendingTurnChatId(afterA, { chatId: "chat_b", active: true })).toBe("chat_b");
  });

  it("lets go once that chat's turn is no longer running", () => {
    const pending = nextPendingTurnChatId(null, { chatId: "chat_a", active: true });
    expect(nextPendingTurnChatId(pending, { chatId: "chat_a", active: false })).toBe(null);
  });

  it("keeps waiting when a different chat goes quiet", () => {
    const pending = nextPendingTurnChatId(null, { chatId: "chat_a", active: true });
    expect(nextPendingTurnChatId(pending, { chatId: "chat_b", active: false })).toBe("chat_a");
  });

  it("stays clear when nothing is pending", () => {
    expect(nextPendingTurnChatId(null, { chatId: "chat_a", active: false })).toBe(null);
  });
});

describe("a turn started behind a closed panel", () => {
  // The page load knew of nothing: no wake, no watch, no unread work. Only the turn can
  // start the poll.
  const quietPageLoad = {
    serverUnreadWakes: 0,
    serverHasActiveWatches: false,
    serverUnreadWork: 0,
    organizationId: "org_quiet",
  };

  it("keeps the poll running until the answer is seen", () => {
    expect(shouldPollWakeFeed({ ...quietPageLoad, turnInFlight: false })).toBe(false);

    // Asked a question, then closed the panel: the panel reports no end, so the latch holds.
    const pending = nextPendingTurnChatId(null, { chatId: "chat_a", active: true });
    expect(shouldPollWakeFeed({ ...quietPageLoad, turnInFlight: pending !== null })).toBe(true);

    // Re-opened the chat with the turn already over.
    const seen = nextPendingTurnChatId(pending, { chatId: "chat_a", active: false });
    expect(shouldPollWakeFeed({ ...quietPageLoad, turnInFlight: seen !== null })).toBe(false);
  });
});
