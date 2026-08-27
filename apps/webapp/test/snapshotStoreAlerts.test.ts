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
    expect(block).toContain(`{__name__=~".*${exported}",outcome="forked"}`);
    expect(block).toContain("severity: page");
  });
});
