import { describe, expect, it } from "vitest";
import { getRunFiltersFromSearchParams } from "~/components/runs/v3/RunFilters";
import { appendRunFilters, navigateDestination, sameOriginPath } from "./navigate-target";

const RUNS_PATH = "/orgs/acme/projects/api/env/prod/runs";

const FAILING = [
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
  "INTERRUPTED",
];

/** What the runs page makes of a URL this module produced. */
function pageReads(path: string) {
  return getRunFiltersFromSearchParams(
    new URLSearchParams(new URL(path, "https://x.invalid").search)
  );
}

describe("appendRunFilters", () => {
  it("returns the path untouched with no filters", () => {
    expect(appendRunFilters(RUNS_PATH)).toBe(RUNS_PATH);
  });

  it("writes arrays as repeated params and keeps existing ones", () => {
    const result = appendRunFilters(`${RUNS_PATH}?query=payments`, {
      statuses: ["COMPLETED_WITH_ERRORS", "CRASHED"],
      tasks: "send-email",
      period: "1d",
    });

    expect(result).toBe(
      `${RUNS_PATH}?query=payments&statuses=COMPLETED_WITH_ERRORS&statuses=CRASHED&tasks=send-email&period=1d`
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

  it("expands FAILED into the statuses the page calls failures", () => {
    const result = appendRunFilters(RUNS_PATH, { statuses: ["FAILED"], period: "1d" });

    expect(pageReads(result)).toEqual({ statuses: FAILING, period: "1d" });
  });

  it("takes the status the user said, however they cased it", () => {
    expect(pageReads(appendRunFilters(RUNS_PATH, { statuses: "failed" }))).toEqual({
      statuses: FAILING,
    });
  });

  it("passes a page-native status through untranslated", () => {
    const result = appendRunFilters(RUNS_PATH, { statuses: ["COMPLETED_SUCCESSFULLY"] });

    expect(result).toBe(`${RUNS_PATH}?statuses=COMPLETED_SUCCESSFULLY`);
    expect(pageReads(result)).toEqual({ statuses: ["COMPLETED_SUCCESSFULLY"] });
  });

  it("translates the other API status names the model borrows", () => {
    expect(pageReads(appendRunFilters(RUNS_PATH, { statuses: ["QUEUED", "COMPLETED"] }))).toEqual({
      statuses: ["PENDING", "COMPLETED_SUCCESSFULLY"],
    });
  });

  it("drops a status the page cannot parse rather than losing every filter with it", () => {
    const result = appendRunFilters(RUNS_PATH, { statuses: ["NONSENSE"], period: "1d" });

    expect(result).toBe(`${RUNS_PATH}?period=1d`);
    expect(pageReads(result)).toEqual({ period: "1d" });
  });

  // The page's parser has no `search`, and an unread param is only noise in the URL.
  it("leaves search out of the URL", () => {
    expect(appendRunFilters(RUNS_PATH, { search: "boom", period: "1d" })).toBe(
      `${RUNS_PATH}?period=1d`
    );
  });

  // Control: the untranslated URL is what the live failure looked like. One status the
  // page cannot parse and it discards everything, the period included.
  it("pins why translation is needed: raw FAILED wipes the whole filter set", () => {
    expect(pageReads(`${RUNS_PATH}?statuses=FAILED&period=1d`)).toEqual({});
  });
});

describe("navigateDestination", () => {
  const SOURCE_URL = "https://github.com/acme/api/blob/abc123/src/tasks/send-email.ts#L42";

  it("routes a dashboard path and applies the intent's filters", () => {
    expect(
      navigateDestination({ path: RUNS_PATH, external: false }, { statuses: ["FAILED"] })
    ).toEqual({
      kind: "route",
      path: `${RUNS_PATH}?${FAILING.map((s) => `statuses=${s}`).join("&")}`,
    });
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
