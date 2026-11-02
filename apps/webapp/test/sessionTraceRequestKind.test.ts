import { describe, expect, it } from "vitest";
import { chunkRequestKind, runsPageRequestKind } from "~/presenters/v3/sessionTraceRequestKind";

describe("chunkRequestKind", () => {
  // Catches: tail and errors-only reads labelled as pages, hiding live-tail load in the metrics.
  it("labels each kind of chunk read", () => {
    expect(chunkRequestKind({ start: "1" })).toBe("first");
    expect(chunkRequestKind({ filter: "errors" })).toBe("errors");
    expect(chunkRequestKind({ insertedAtSince: 0 })).toBe("tail");
    expect(chunkRequestKind({})).toBe("page");
  });
});

describe("runsPageRequestKind", () => {
  // Catches: polls and focus refreshes counted as opens, inflating Trace tab usage.
  it("labels the newest page by the client's reason, and older reads by their params", () => {
    expect(runsPageRequestKind({ reason: "poll" })).toBe("poll");
    expect(runsPageRequestKind({ reason: "focus" })).toBe("focus");
    expect(runsPageRequestKind({ run: "run_abc", reason: "poll" })).toBe("deepLink");
    expect(runsPageRequestKind({ "page[after]": { id: "x" } })).toBe("earlier");
    expect(runsPageRequestKind({})).toBe("open");
  });
});
