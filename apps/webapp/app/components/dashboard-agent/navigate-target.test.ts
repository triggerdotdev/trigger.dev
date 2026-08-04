import { describe, expect, it } from "vitest";
import { appendRunFilters, sameOriginPath } from "./navigate-target";

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
