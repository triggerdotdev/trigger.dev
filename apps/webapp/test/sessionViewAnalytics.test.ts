import { describe, expect, it } from "vitest";
import {
  newBudgetOutcomes,
  searchStarted,
  sessionViewer,
  sessionViewEventProperties,
} from "~/components/sessions/v1/trace/sessionViewAnalytics";

describe("sessionViewer", () => {
  // Catches: an impersonating admin counted as an admin, so staff use hides in member numbers.
  it("puts impersonation first, then admin", () => {
    expect(sessionViewer(true, true)).toBe("impersonating");
    expect(sessionViewer(true, false)).toBe("admin");
    expect(sessionViewer(undefined, false)).toBe("member");
  });
});

describe("sessionViewEventProperties", () => {
  // Catches: an extra property named `action` or `viewer` overwriting the event's own.
  it("keeps the action and viewer over extras with the same names", () => {
    expect(
      sessionViewEventProperties(
        "load_all",
        { viewer: "member", runsShown: 20 },
        { runs: 5, action: "x", viewer: "admin" }
      )
    ).toEqual({ runs: 5, action: "load_all", viewer: "member", runs_shown: 20 });
  });
});

describe("newBudgetOutcomes", () => {
  const none = { freed: 0, cutOff: 0 };

  // Catches: a cut-off going unreported when a free happened in the same update.
  it("reports each outcome the first time it happens", () => {
    expect(newBudgetOutcomes(none, { freed: 2, cutOff: 1 }, new Set())).toEqual([
      "freed",
      "cut_off",
    ]);
  });

  // Catches: one event per free while Expand all pages near the limit.
  it("doesn't report an outcome again in the same page view", () => {
    expect(
      newBudgetOutcomes({ freed: 1, cutOff: 0 }, { freed: 3, cutOff: 0 }, new Set(["freed"]))
    ).toEqual([]);
  });
});

describe("searchStarted", () => {
  const off = { text: "", errorsOnly: false };

  // Catches: errors-only searches never counted as a search.
  it("fires when text or errors-only turns a search on", () => {
    expect(searchStarted(off, { text: "a", errorsOnly: false })).toBe(true);
    expect(searchStarted(off, { text: "", errorsOnly: true })).toBe(true);
  });

  // Catches: one "search used" event per keystroke, or one when the search is cleared.
  it("doesn't fire while typing in a search already on, or when clearing it", () => {
    expect(searchStarted({ text: "a", errorsOnly: false }, { text: "ab", errorsOnly: false })).toBe(
      false
    );
    expect(searchStarted({ text: "a", errorsOnly: false }, off)).toBe(false);
  });
});
