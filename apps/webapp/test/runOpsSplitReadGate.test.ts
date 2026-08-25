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

describe("computeRunOpsSplitReadEnabled shard handles", () => {
  const shardA = { __tag: "shard-a" };
  const shardB = { __tag: "shard-b" };
  const base = {
    newReplica: dedicatedNew,
    controlPlaneWriter: cpWriter,
    controlPlaneReplica: cpReplica,
    hasNewUrl: true,
    hasLegacyUrl: true,
  };

  it("does not warn when every shard handle is a distinct instance", () => {
    const warn = vi.fn();
    const enabled = computeRunOpsSplitReadEnabled({
      ...base,
      shardHandles: [
        { key: "a", replica: shardA },
        { key: "b", replica: shardB },
      ],
      logger: { warn },
    });
    expect(enabled).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns, naming the shard, when a shard replica aliases a control-plane handle", () => {
    const warn = vi.fn();
    computeRunOpsSplitReadEnabled({
      ...base,
      shardHandles: [{ key: "a", replica: cpReplica }],
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/shard a/i);
  });

  it("warns when a shard replica aliases the gen-1 new replica", () => {
    const warn = vi.fn();
    computeRunOpsSplitReadEnabled({
      ...base,
      shardHandles: [{ key: "a", replica: dedicatedNew }],
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does NOT warn for an aliased shard, because sharing is its purpose", () => {
    const warn = vi.fn();
    computeRunOpsSplitReadEnabled({
      ...base,
      shardHandles: [{ key: "z", replica: dedicatedNew, aliasOf: "new" as const }],
      logger: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // The distinctness sentinel already fail-closes the boot on this condition. A gen-2 fault must
  // not disable the proven gen-1 read fan-out on top of that.
  it("keeps the gen-1 verdict when a shard handle is not distinct", () => {
    expect(
      computeRunOpsSplitReadEnabled({
        ...base,
        shardHandles: [{ key: "a", replica: cpReplica }],
      })
    ).toBe(true);
  });

  it("warns once per offending shard", () => {
    const warn = vi.fn();
    computeRunOpsSplitReadEnabled({
      ...base,
      shardHandles: [
        { key: "a", replica: cpReplica },
        { key: "b", replica: cpWriter },
      ],
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("is unchanged when no shard handle is supplied", () => {
    const warn = vi.fn();
    expect(computeRunOpsSplitReadEnabled({ ...base, logger: { warn } })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
