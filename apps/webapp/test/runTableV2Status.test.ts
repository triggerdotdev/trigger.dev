import { describe, expect, it } from "vitest";
import { canMintV2Run, v2RunsMayExist } from "~/v3/runTableV2Status.server";

// The module caches its status in a globalThis singleton ("runTableV2Status").
// In the unit-test env runs replication is unconfigured, so it initializes to
// { published:false, hasRows:false } with no background poller. Mutate that
// cached object to exercise the gates deterministically.
function setStatus(published: boolean, hasRows: boolean) {
  const singletons = (globalThis as any).__trigger_singletons;
  // Force module init (the singleton is created on first getter call/import).
  v2RunsMayExist(false);
  singletons.runTableV2Status.published = published;
  singletons.runTableV2Status.hasRows = hasRows;
}

const CUTOVER_FLAGS = { realtimeBackend: "native", runTableV2: true };

describe("canMintV2Run (mint gate: org cut over AND task_run_v2 published)", () => {
  it("mints v2 only when the org is cut over AND the table is published", () => {
    setStatus(true, true);
    expect(canMintV2Run(CUTOVER_FLAGS, { nativeRealtimeEnabled: true })).toBe(true);
  });

  it("fails safe to legacy when the org is cut over but the table is NOT published", () => {
    setStatus(false, true);
    expect(canMintV2Run(CUTOVER_FLAGS, { nativeRealtimeEnabled: true })).toBe(false);
  });

  it("stays legacy when the org is not cut over, even if published", () => {
    setStatus(true, true);
    expect(
      canMintV2Run({ realtimeBackend: "electric", runTableV2: false }, { nativeRealtimeEnabled: true })
    ).toBe(false);
    expect(canMintV2Run(CUTOVER_FLAGS, { nativeRealtimeEnabled: false })).toBe(false);
  });
});

describe("v2RunsMayExist (read scope: native on OR table has rows)", () => {
  it("is true when native realtime is on (v2 being minted now)", () => {
    setStatus(false, false);
    expect(v2RunsMayExist(true)).toBe(true);
  });

  it("is true when task_run_v2 already has rows even with native OFF (rollback safety)", () => {
    setStatus(false, true);
    expect(v2RunsMayExist(false)).toBe(true);
  });

  it("is false only when native is off AND no v2 run has ever existed", () => {
    setStatus(false, false);
    expect(v2RunsMayExist(false)).toBe(false);
  });
});
