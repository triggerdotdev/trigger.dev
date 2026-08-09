import { describe, expect, it } from "vitest";
import { appendRunFilters, navigateDestination, sameOriginPath } from "./navigate-target";

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

describe("navigateDestination", () => {
  const SOURCE_URL = "https://github.com/acme/api/blob/abc123/src/tasks/send-email.ts#L42";

  it("routes a dashboard path and applies the intent's filters", () => {
    expect(
      navigateDestination({ path: RUNS_PATH, external: false }, { statuses: ["FAILED"] })
    ).toEqual({ kind: "route", path: `${RUNS_PATH}?statuses=FAILED` });
  });

  it("never routes a source file, it leaves the dashboard", () => {
    expect(navigateDestination({ path: SOURCE_URL, external: true })).toEqual({
      kind: "external",
      url: SOURCE_URL,
    });
  });

  it("refuses to route an absolute URL even when the server forgot to flag it", () => {
    expect(navigateDestination({ path: SOURCE_URL })).toEqual({
      kind: "external",
      url: SOURCE_URL,
    });
  });

  it("refuses a protocol-relative path, which would change host", () => {
    expect(navigateDestination({ path: "//evil.example/runs" })).toEqual({ kind: "none" });
    expect(navigateDestination({ path: "/\\evil.example/runs" })).toEqual({ kind: "none" });
  });

  it("resolves to nothing when there is no target", () => {
    expect(navigateDestination(null)).toEqual({ kind: "none" });
    expect(navigateDestination({ path: "" })).toEqual({ kind: "none" });
    expect(navigateDestination({ path: "javascript:alert(1)" })).toEqual({ kind: "none" });
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
