import { describe, expect, it } from "vitest";
import { sendRequestOutcome } from "./send-request";

describe("sendRequestOutcome", () => {
  it("sends a request the chat can take", () => {
    expect(sendRequestOutcome({ requestSeq: 1, consumedSeq: undefined, canSend: true })).toBe(
      "send"
    );
  });

  it("skips a request it has already sent", () => {
    expect(sendRequestOutcome({ requestSeq: 1, consumedSeq: 1, canSend: true })).toBe("skip");
  });

  it("skips when nothing was asked for", () => {
    expect(sendRequestOutcome({ requestSeq: undefined, consumedSeq: 3, canSend: true })).toBe(
      "skip"
    );
  });

  it("holds a request the chat can't take yet, and sends it once it can", () => {
    expect(sendRequestOutcome({ requestSeq: 2, consumedSeq: 1, canSend: false })).toBe("hold");
    // The held click is still the same request: nothing consumed it while it waited.
    expect(sendRequestOutcome({ requestSeq: 2, consumedSeq: 1, canSend: true })).toBe("send");
  });
});
