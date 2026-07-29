import { describe, expect, it } from "vitest";
import { appendRunFilters, pendingNavigateIntents, sameOriginPath } from "./navigate-target";

const RUNS_PATH = "/orgs/acme/projects/api/env/prod/runs";

describe("appendRunFilters", () => {
  it("returns the path untouched with no filters", () => {
    expect(appendRunFilters(RUNS_PATH)).toBe(RUNS_PATH);
  });

  it("writes arrays as repeated params and keeps existing ones", () => {
    const result = appendRunFilters(`${RUNS_PATH}?query=payments`, {
      statuses: ["FAILED", "CRASHED"],
      tasks: "send-email",
      period: "1d",
    });

    expect(result).toBe(
      `${RUNS_PATH}?query=payments&statuses=FAILED&statuses=CRASHED&tasks=send-email&period=1d`
    );
  });

  it("converts absolute bounds to epoch milliseconds", () => {
    const result = appendRunFilters(RUNS_PATH, { from: "2026-01-01T00:00:00.000Z" });

    expect(result).toBe(`${RUNS_PATH}?from=${Date.parse("2026-01-01T00:00:00.000Z")}`);
  });

  it("drops empty values and false booleans", () => {
    expect(appendRunFilters(RUNS_PATH, { search: "", rootOnly: false, tags: [] })).toBe(RUNS_PATH);
    expect(appendRunFilters(RUNS_PATH, { rootOnly: true })).toBe(`${RUNS_PATH}?rootOnly=true`);
  });
});

describe("sameOriginPath", () => {
  const origin = "http://localhost:3030";

  it("turns an absolute dashboard URL into a path", () => {
    expect(sameOriginPath(`${origin}${RUNS_PATH}?statuses=FAILED#top`, origin)).toBe(
      `${RUNS_PATH}?statuses=FAILED#top`
    );
  });

  it("returns null for another origin", () => {
    expect(sameOriginPath("https://trigger.dev/docs/errors", origin)).toBeNull();
  });

  it("returns null for a URL it can't parse", () => {
    expect(sameOriginPath("not a url", "")).toBeNull();
  });
});

describe("pendingNavigateIntents", () => {
  const uri = "trigger://proj_abc/env_123/run/run_abc";
  const toolPart = (toolCallId: string, state = "output-available") => ({
    type: "tool-navigate_to",
    state,
    toolCallId,
    output: { intent: { kind: "navigate", target: uri } },
  });

  it("returns the intent from a completed navigate_to call, once", () => {
    const seen = new Set<string>();
    const messages = [{ id: "m1", parts: [toolPart("call-1")] }];

    expect(pendingNavigateIntents(messages, seen)).toEqual([{ kind: "navigate", target: uri }]);
    expect(pendingNavigateIntents(messages, seen)).toEqual([]);
  });

  it("ignores a call that hasn't produced output yet", () => {
    expect(
      pendingNavigateIntents(
        [{ id: "m1", parts: [toolPart("call-1", "input-available")] }],
        new Set()
      )
    ).toEqual([]);
  });

  it("ignores output that isn't a navigate intent", () => {
    const messages = [
      { id: "m1", parts: [{ ...toolPart("call-1"), output: { error: "nowhere to go" } }] },
      { id: "m2", parts: [{ type: "text", text: "hello" }] },
    ];

    expect(pendingNavigateIntents(messages, new Set())).toEqual([]);
  });

  it("skips calls seeded as already seen (loaded history)", () => {
    const history = [{ id: "m1", parts: [toolPart("call-1")] }];
    const seen = new Set<string>();
    pendingNavigateIntents(history, seen);

    expect(
      pendingNavigateIntents([...history, { id: "m2", parts: [toolPart("call-2")] }], seen)
    ).toEqual([{ kind: "navigate", target: uri }]);
  });
});
