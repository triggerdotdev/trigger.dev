import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
});
