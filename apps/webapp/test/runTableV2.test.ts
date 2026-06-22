import { describe, expect, it } from "vitest";
import { shouldUseV2RunTable } from "~/v3/runTableV2.server";

// v2 is gated on the org being served realtime by the NATIVE backend (Electric
// can't observe task_run_v2). That requires the deployment master switch
// (nativeRealtimeEnabled) AND the per-org `realtimeBackend` flag set to "native".
const NATIVE_ON = { nativeRealtimeEnabled: true };
const NATIVE_OFF = { nativeRealtimeEnabled: false };
const onNative = (extra: Record<string, unknown> = {}) => ({ realtimeBackend: "native", ...extra });

describe("shouldUseV2RunTable", () => {
  it("defaults to false when the org has no flags", () => {
    expect(shouldUseV2RunTable(null, NATIVE_ON)).toBe(false);
    expect(shouldUseV2RunTable(undefined, NATIVE_ON)).toBe(false);
    expect(shouldUseV2RunTable({}, NATIVE_ON)).toBe(false);
  });

  it("returns true only when runTableV2 is boolean true AND the org is on native realtime", () => {
    expect(shouldUseV2RunTable(onNative({ runTableV2: true }), NATIVE_ON)).toBe(true);
    expect(shouldUseV2RunTable(onNative({ runTableV2: false }), NATIVE_ON)).toBe(false);
  });

  it("requires the native realtime backend (Electric can't observe v2 runs)", () => {
    // runTableV2 on, but the org is not on native realtime → no v2 (it would be
    // realtime-invisible).
    expect(shouldUseV2RunTable({ runTableV2: true }, NATIVE_ON)).toBe(false);
    expect(shouldUseV2RunTable({ runTableV2: true, realtimeBackend: "electric" }, NATIVE_ON)).toBe(
      false
    );
    expect(shouldUseV2RunTable({ runTableV2: true, realtimeBackend: "shadow" }, NATIVE_ON)).toBe(
      false
    );
    // On native per-org, but the deployment master switch is off → effectively
    // still Electric → no v2.
    expect(shouldUseV2RunTable(onNative({ runTableV2: true }), NATIVE_OFF)).toBe(false);
  });

  it("rejects a stringified flag value (strict boolean, no coercion)", () => {
    // A stringified "false" must not coerce to true and cut the org over.
    expect(shouldUseV2RunTable(onNative({ runTableV2: "true" }), NATIVE_ON)).toBe(false);
    expect(shouldUseV2RunTable(onNative({ runTableV2: "false" }), NATIVE_ON)).toBe(false);
    expect(shouldUseV2RunTable(onNative({ runTableV2: 1 }), NATIVE_ON)).toBe(false);
  });

  it("ignores unrelated flags and non-object inputs", () => {
    expect(shouldUseV2RunTable(onNative({ mollifierEnabled: true }), NATIVE_ON)).toBe(false);
    expect(shouldUseV2RunTable("runTableV2", NATIVE_ON)).toBe(false);
    expect(shouldUseV2RunTable(42, NATIVE_ON)).toBe(false);
  });
});
