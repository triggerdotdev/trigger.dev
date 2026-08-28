import { describe, expect, it } from "vitest";
import { isTurnErrorMessageId, shouldShowLiveTurnError } from "./turn-error";

const answer = { id: "msg_1" };
const failure = { id: "turn-error:0" };

describe("the failed-turn record", () => {
  it("recognises the agent's failure message id", () => {
    expect(isTurnErrorMessageId("turn-error:3")).toBe(true);
    expect(isTurnErrorMessageId("wake:watch:watch_1:fired")).toBe(false);
    expect(isTurnErrorMessageId(undefined)).toBe(false);
  });

  it("shows the live callout while only the stream knows about the failure", () => {
    expect(shouldShowLiveTurnError(new Error("failed"), [answer])).toBe(true);
  });

  // A reload replays the stored record, so the callout would be the second copy.
  it("hides the live callout once the transcript ends in the stored record", () => {
    expect(shouldShowLiveTurnError(new Error("failed"), [answer, failure])).toBe(false);
  });

  // An older failure further back must not silence a new one.
  it("still shows a new failure after an earlier stored record", () => {
    expect(shouldShowLiveTurnError(new Error("failed"), [failure, answer])).toBe(true);
  });

  it("shows nothing when the turn didn't fail", () => {
    expect(shouldShowLiveTurnError(undefined, [answer])).toBe(false);
  });
});
