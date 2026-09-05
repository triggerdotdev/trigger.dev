import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APPEND_RESULT_OUTCOMES } from "@internal/run-store";
import { SNAPSHOT_STORE_WRITE_TOTAL } from "~/v3/snapshotStoreMetrics.server";

const RULES = fs.readFileSync(
  path.resolve(__dirname, "../../../docker/config/alerts/snapshot-store.yml"),
  "utf8"
);

function ruleBlock(alertName: string): string {
  const start = RULES.indexOf(`- alert: ${alertName}`);
  if (start === -1) return "";
  const next = RULES.indexOf("- alert:", start + 1);
  return RULES.slice(start, next === -1 ? undefined : next);
}

describe("the snapshot store alerting rules", () => {
  it("match on the name suffix, because the exported prefix is deployment-dependent", () => {
    const matchers = [...RULES.matchAll(/__name__=~"([^"]+)"/g)].map((m) => m[1]);

    expect(matchers.length).toBeGreaterThan(0);
    for (const matcher of matchers) {
      expect(matcher.startsWith(".*")).toBe(true);
    }
  });

  it("pages on a forked append, against the counter the decorator actually writes", () => {
    const block = ruleBlock("SnapshotStoreAppendForked");
    const exported = SNAPSHOT_STORE_WRITE_TOTAL.replaceAll(".", "_");

    expect(APPEND_RESULT_OUTCOMES).toContain("forked");
    // The name still comes from the code constant, which is the point of this test: a rule matching
    // a metric nothing emits is the failure mode here, and that has happened once already.
    //
    // The trailing `(_total)?` is deliberate. OTel exporters may or may not append `_total` to a
    // counter, and a matcher that guesses wrong matches nothing at all while looking perfectly
    // reasonable. Accepting both spellings costs nothing; a silent alert costs everything.
    expect(block).toContain(`{__name__=~".*${exported}(_total)?",outcome="forked"}`);
    expect(block).toContain("severity: page");
  });

  it("tolerates an optional _total on every matcher, so no rule can silently match nothing", () => {
    const matchers = [...RULES.matchAll(/__name__=~"([^"]+)"/g)].map((m) => m[1]);

    expect(matchers.length).toBeGreaterThan(0);
    for (const matcher of matchers) {
      expect(matcher.endsWith("(_total)?")).toBe(true);
    }
  });
});
