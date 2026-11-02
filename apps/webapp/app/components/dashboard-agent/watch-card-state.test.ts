import type { WatchDraft } from "@internal/dashboard-agent-contracts";
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
