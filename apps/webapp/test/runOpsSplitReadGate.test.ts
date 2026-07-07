import { describe, expect, it, vi } from "vitest";
import { computeRunOpsSplitReadEnabled } from "~/v3/runOpsMigration/runOpsSplitReadGate";

// Distinct sentinel objects standing in for the prisma client singletons.
const cpWriter = { __tag: "cp-writer" };
const cpReplica = { __tag: "cp-replica" };
const dedicatedNew = { __tag: "dedicated-new" };

describe("computeRunOpsSplitReadEnabled", () => {
  it("enables split when a distinct dedicated NEW client is open and both URLs are set", () => {
    expect(
      computeRunOpsSplitReadEnabled({
        newReplica: dedicatedNew,
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica,
        hasNewUrl: true,
        hasLegacyUrl: true,
      })
    ).toBe(true);
  });

  // Regression: the LEGACY run-ops handle IS the control-plane replica by design. The gate must
  // depend only on the NEW client's distinctness — never on the legacy handle differing from CP.
  it("stays enabled even though the legacy handle equals the control-plane replica", () => {
    // The caller passes controlPlaneReplica (=== legacy handle) for the CP slot; NEW is still
    // distinct, so split must remain ON. (A gate that required legacy !== CP would be false here.)
    expect(
      computeRunOpsSplitReadEnabled({
        newReplica: dedicatedNew,
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica, // legacy run-ops replica is this very object in prod
        hasNewUrl: true,
        hasLegacyUrl: true,
      })
    ).toBe(true);
  });

  it("disables split when NEW falls back to the control-plane client (no dedicated DB)", () => {
    expect(
      computeRunOpsSplitReadEnabled({
        newReplica: cpReplica, // cpFallback: NEW === control-plane replica
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica,
        hasNewUrl: true,
        hasLegacyUrl: true,
      })
    ).toBe(false);
  });

  it("disables split when NEW equals the control-plane writer", () => {
    expect(
      computeRunOpsSplitReadEnabled({
        newReplica: cpWriter,
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica,
        hasNewUrl: true,
        hasLegacyUrl: true,
      })
    ).toBe(false);
  });

  it("disables split when either URL is missing, even with a distinct client", () => {
    const base = {
      newReplica: dedicatedNew,
      controlPlaneWriter: cpWriter,
      controlPlaneReplica: cpReplica,
    };
    expect(computeRunOpsSplitReadEnabled({ ...base, hasNewUrl: false, hasLegacyUrl: true })).toBe(
      false
    );
    expect(computeRunOpsSplitReadEnabled({ ...base, hasNewUrl: true, hasLegacyUrl: false })).toBe(
      false
    );
  });

  // Observability regression guard: split-configured (both URLs set) but the NEW client is not a
  // distinct instance must WARN loudly. Without this signal, an accidental refactor that makes the
  // NEW client alias a control-plane client silently disables read fan-out with zero error/warning.
  describe("warn signal when configured-but-aliased", () => {
    it("warns when both URLs are set but NEW aliases the control-plane replica", () => {
      const warn = vi.fn();
      const enabled = computeRunOpsSplitReadEnabled({
        newReplica: cpReplica, // aliasing regression: NEW === control-plane replica
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica,
        hasNewUrl: true,
        hasLegacyUrl: true,
        logger: { warn },
      });

      expect(enabled).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/split.*configured/i);
    });

    it("warns when both URLs are set but NEW aliases the control-plane writer", () => {
      const warn = vi.fn();
      const enabled = computeRunOpsSplitReadEnabled({
        newReplica: cpWriter, // aliasing regression: NEW === control-plane writer
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica,
        hasNewUrl: true,
        hasLegacyUrl: true,
        logger: { warn },
      });

      expect(enabled).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("does NOT warn in ordinary single mode (both URLs unset, clients naturally aliased)", () => {
      const warn = vi.fn();
      const enabled = computeRunOpsSplitReadEnabled({
        newReplica: cpReplica,
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica,
        hasNewUrl: false,
        hasLegacyUrl: false,
        logger: { warn },
      });

      expect(enabled).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does NOT warn when only one URL is set (not truly configured for split)", () => {
      const warn = vi.fn();
      computeRunOpsSplitReadEnabled({
        newReplica: cpReplica,
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica,
        hasNewUrl: true,
        hasLegacyUrl: false,
        logger: { warn },
      });

      expect(warn).not.toHaveBeenCalled();
    });

    it("does NOT warn when the NEW client is genuinely distinct (healthy split)", () => {
      const warn = vi.fn();
      const enabled = computeRunOpsSplitReadEnabled({
        newReplica: dedicatedNew,
        controlPlaneWriter: cpWriter,
        controlPlaneReplica: cpReplica,
        hasNewUrl: true,
        hasLegacyUrl: true,
        logger: { warn },
      });

      expect(enabled).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not throw when no logger is supplied (logger stays optional)", () => {
      expect(() =>
        computeRunOpsSplitReadEnabled({
          newReplica: cpReplica,
          controlPlaneWriter: cpWriter,
          controlPlaneReplica: cpReplica,
          hasNewUrl: true,
          hasLegacyUrl: true,
        })
      ).not.toThrow();
    });
  });
});
