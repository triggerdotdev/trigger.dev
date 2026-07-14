import { describe, expect, it, vi } from "vitest";
import {
  assertControlPlaneCoresidencyAdvisory,
  resolveCoresidencyEnforcement,
} from "./controlPlaneCoresidencySentinel.server";
import type { CoresidencyVerdict } from "./distinctDbSentinel.server";

const noopLog = { info: () => {}, warn: () => {} };

describe("resolveCoresidencyEnforcement", () => {
  // Enforcement fires ONLY when the operator opted in AND co-residency is positively "true".
  const cases: Array<{ expectSplit: boolean; coresident: CoresidencyVerdict; throws: boolean }> = [
    { expectSplit: true, coresident: "true", throws: true },
    { expectSplit: true, coresident: "false", throws: false },
    { expectSplit: true, coresident: "unknown", throws: false }, // a denied probe must never fail boot
    { expectSplit: false, coresident: "true", throws: false }, // same-DSN stage: advisory only
    { expectSplit: false, coresident: "false", throws: false },
    { expectSplit: false, coresident: "unknown", throws: false },
  ];
  for (const c of cases) {
    it(`expectSplit=${c.expectSplit} coresident=${c.coresident} -> throw=${c.throws}`, () => {
      expect(
        resolveCoresidencyEnforcement({ expectSplit: c.expectSplit, coresident: c.coresident })
          .throw
      ).toBe(c.throws);
    });
  }
});

describe("assertControlPlaneCoresidencyAdvisory", () => {
  const urls = { legacyUrl: "postgres://legacy", controlPlaneUrl: "postgres://cp" };

  it("emits the probed verdict and does not throw in the same-DSN stage (expectSplit off)", async () => {
    const emit = vi.fn();
    await assertControlPlaneCoresidencyAdvisory({
      ...urls,
      expectSplit: false,
      probe: async () => ({ coresident: "true" }),
      emit,
      log: noopLog,
    });
    expect(emit).toHaveBeenCalledWith("true");
  });

  it("throws only when enforcement is opted in AND co-residency is confirmed true", async () => {
    await expect(
      assertControlPlaneCoresidencyAdvisory({
        ...urls,
        expectSplit: true,
        probe: async () => ({ coresident: "true" }),
        emit: vi.fn(),
        log: noopLog,
      })
    ).rejects.toThrow(/co-resident/);
  });

  it("never enforces on unknown even when opted in", async () => {
    const emit = vi.fn();
    await assertControlPlaneCoresidencyAdvisory({
      ...urls,
      expectSplit: true,
      probe: async () => ({ coresident: "unknown", reason: "denied" }),
      emit,
      log: noopLog,
    });
    expect(emit).toHaveBeenCalledWith("unknown");
  });

  it("degrades a throwing probe to unknown and never crashes boot", async () => {
    const emit = vi.fn();
    const warn = vi.fn();
    await assertControlPlaneCoresidencyAdvisory({
      ...urls,
      expectSplit: true,
      probe: async () => {
        throw new Error("probe blew up");
      },
      emit,
      log: { info: () => {}, warn },
    });
    expect(emit).toHaveBeenCalledWith("unknown");
    expect(warn).toHaveBeenCalled();
  });

  it("no-ops (no probe, no emit) when there is no legacy DSN", async () => {
    const emit = vi.fn();
    const probe = vi.fn();
    await assertControlPlaneCoresidencyAdvisory({
      legacyUrl: undefined,
      controlPlaneUrl: "postgres://cp",
      expectSplit: true,
      probe,
      emit,
      log: noopLog,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
