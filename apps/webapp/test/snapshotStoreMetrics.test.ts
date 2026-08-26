import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPEND_RESULT_OUTCOMES } from "@internal/run-store";
import { WRITE_OUTCOMES } from "~/v3/snapshotStoreMetrics.server";

const SOURCE_PATH = join(process.cwd(), "app/v3/snapshotStoreMetrics.server.ts");

describe("snapshotStoreMetrics module shape", () => {
  // An instrument created but never incremented emits no data point, so a MeterProvider cannot see
  // one that drifted back to module scope, where it would register on every boot.
  const source = readFileSync(SOURCE_PATH, "utf8");
  const factoryAt = source.indexOf("export function createSnapshotStoreMetrics");

  it("exports the factory", () => {
    expect(factoryAt).toBeGreaterThan(-1);
  });

  it("creates every instrument inside the factory", () => {
    const creations = [
      ...source.matchAll(/create(Counter|Histogram|UpDownCounter|Observable\w*)\(/g),
    ];
    expect(creations.length).toBeGreaterThan(0);
    for (const match of creations) {
      expect(match.index).toBeGreaterThan(factoryAt);
    }
  });

  it("calls getMeter nowhere at module scope", () => {
    expect(source).not.toMatch(/^\s*(const|let|var)\s+\w+\s*=\s*getMeter\(/m);
  });

  it("declares no counter that has no producer in this ticket", () => {
    // A counter pinned at zero looks the same as a working one that found nothing.
    expect(source).not.toMatch(/compare_divergence/);
    expect(source).not.toMatch(/\btrimmed\b/);
  });

  it("bounds the write outcome against the store's own vocabulary", () => {
    // Any outcome the store can return but the allowlist omits collapses to "other", which hides
    // forked appends: the signal that a run's Redis head has frozen.
    for (const outcome of APPEND_RESULT_OUTCOMES) {
      expect(WRITE_OUTCOMES).toContain(outcome);
    }
  });

  it("declares no counter whose only producer is unreachable", () => {
    // recordWrite is called once, with an AppendResult outcome. "staged" and "post_expiry" are not
    // in that vocabulary, so both counters sat at zero and both branches were dead.
    expect(source).not.toMatch(/flush_staged/);
    expect(source).not.toMatch(/post_expiry_write/);
  });

  it("gives the two layers separate counters", () => {
    // Sharing one would count a single logical write twice and mix {outcome, ttl} points with
    // {site, outcome} points under one name.
    const appendBlock = source.slice(
      source.indexOf("recordAppend:"),
      source.indexOf("recordWrite:")
    );
    const writeBlock = source.slice(source.indexOf("recordWrite:"));
    expect(appendBlock).toMatch(/appendTotal\.add/);
    expect(appendBlock).not.toMatch(/writeTotal\.add/);
    expect(writeBlock).toMatch(/writeTotal\.add/);
    expect(writeBlock).not.toMatch(/appendTotal\.add/);
  });
});
