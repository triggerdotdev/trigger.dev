// Pure-core tests for the known-migrated filter. The injected `readMarker`/`probeNew`
// are PURE BOUNDARIES (the marker source and the new-DB existence predicate), not DB
// mocks — the DB-crossing proof for `probeNew` lives in readThrough.server.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { containerTest } from "@internal/testcontainers";
import {
  ensureRedirectMarkerTable,
  writeRedirectMarker,
  isFenced,
} from "@internal/run-engine";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import {
  computeKnownMigrated,
  isKnownMigrated,
  __resetKnownMigratedCacheForTests,
} from "./knownMigratedFilter.server";

describe("computeKnownMigrated", () => {
  beforeEach(() => {
    __resetKnownMigratedCacheForTests();
  });

  it("(a) marker present → migrated, without probing new", async () => {
    const readMarker = vi.fn(async () => true);
    const probeNew = vi.fn(async () => false);

    const result = await computeKnownMigrated("run_a", { readMarker, probeNew });

    expect(result).toBe(true);
    expect(readMarker).toHaveBeenCalledTimes(1);
    expect(probeNew).not.toHaveBeenCalled();
  });

  it("(b) marker absent + new-probe hit → migrated", async () => {
    const readMarker = vi.fn(async () => false);
    const probeNew = vi.fn(async () => true);

    const result = await computeKnownMigrated("run_b", { readMarker, probeNew });

    expect(result).toBe(true);
    expect(readMarker).toHaveBeenCalledTimes(1);
    expect(probeNew).toHaveBeenCalledTimes(1);
  });

  it("(c) marker absent + new-probe miss → NOT migrated", async () => {
    const readMarker = vi.fn(async () => false);
    const probeNew = vi.fn(async () => false);

    const result = await computeKnownMigrated("run_c", { readMarker, probeNew });

    expect(result).toBe(false);
    expect(readMarker).toHaveBeenCalledTimes(1);
    expect(probeNew).toHaveBeenCalledTimes(1);
  });

  it("(d) a positive is memoized: second call re-invokes neither readMarker nor probeNew", async () => {
    const cache = new BoundedTtlCache<boolean>(60_000, 100);
    const readMarker = vi.fn(async () => false);
    const probeNew = vi.fn(async () => true);

    const first = await computeKnownMigrated("run_d", {
      readMarker,
      probeNew,
      cache,
      ttlMs: 60_000,
    });
    expect(first).toBe(true);

    const second = await computeKnownMigrated("run_d", {
      readMarker,
      probeNew,
      cache,
      ttlMs: 60_000,
    });
    expect(second).toBe(true);

    // The boundaries ran exactly once, on the first call only.
    expect(readMarker).toHaveBeenCalledTimes(1);
    expect(probeNew).toHaveBeenCalledTimes(1);
  });
});

describe("isKnownMigrated marker authority", () => {
  beforeEach(() => {
    __resetKnownMigratedCacheForTests();
  });

  // The OLD-side redirect marker is the authority: once written, the run is "known
  // migrated" WITHOUT a NEW-DB probe. `containerTest` gives a real PG to host the
  // marker table; `probeNew` is forced false to prove the marker path alone decides.
  containerTest(
    "a written redirect marker makes a run known-migrated via isFenced (no new-probe)",
    async ({ prisma }) => {
      await ensureRedirectMarkerTable(prisma);
      const runId = "run_marker_authority";

      const probeNew = vi.fn(async () => false);
      const readMarker = (id: string) => isFenced(prisma, id);

      // Before the marker: not fenced → not migrated → probeNew consulted (and false).
      expect(await computeKnownMigrated(runId, { readMarker, probeNew })).toBe(false);
      expect(probeNew).toHaveBeenCalledTimes(1);

      // Write the OLD-side marker, reset the cache, re-evaluate: now migrated by marker
      // alone, and probeNew is NOT consulted again.
      await writeRedirectMarker(prisma, { runId, reason: "live-migration" });
      __resetKnownMigratedCacheForTests();
      probeNew.mockClear();

      expect(await computeKnownMigrated(runId, { readMarker, probeNew })).toBe(true);
      expect(probeNew).not.toHaveBeenCalled();
    }
  );

  containerTest(
    "the DEFAULT readMarker consults isFenced on the legacy replica",
    async ({ prisma }) => {
      await ensureRedirectMarkerTable(prisma);
      const runId = "run_default_marker";

      // Inject the legacy-replica client the default adapter reads from; force probeNew
      // false so only the marker can flip the result.
      const probeNew = vi.fn(async () => false);

      // No `readMarker` passed → the wired default must read the marker via isFenced.
      await writeRedirectMarker(prisma, { runId, reason: "live-migration" });
      expect(
        await isKnownMigrated(runId, { legacyMarkerClient: prisma, probeNew })
      ).toBe(true);
      expect(probeNew).not.toHaveBeenCalled();
    }
  );
});
