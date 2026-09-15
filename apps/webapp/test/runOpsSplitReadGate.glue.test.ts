import { describe, expect, it, vi } from "vitest";
import { selectRunOpsTopology } from "~/db.server";
import { computeRunOpsSplitReadEnabled } from "~/v3/runOpsMigration/runOpsSplitReadGate";

// Glue test: nothing previously asserted that selectRunOpsTopology's ACTUAL output, fed into
// computeRunOpsSplitReadEnabled, yields the right gate. Each unit was only tested against
// hand-rolled objects, so a refactor that made the NEW client alias a control-plane client
// (even with correct URLs) would silently disable read fan-out with zero test failure.
const cp = { writer: { __tag: "cp-writer" } as any, replica: { __tag: "cp-replica" } as any };

describe("selectRunOpsTopology -> computeRunOpsSplitReadEnabled (seam)", () => {
  it("split-configured with a genuinely distinct NEW client: gate TRUE, no warn", () => {
    const dedicatedNew = { __tag: "dedicated-new" } as any;
    const topo = selectRunOpsTopology(
      { splitEnabled: true, legacyUrl: "postgres://legacy", newUrl: "postgres://new" },
      {
        controlPlane: cp,
        buildNewWriter: vi.fn().mockReturnValue(dedicatedNew),
        buildNewReplica: vi.fn(),
        buildLegacyWriter: vi.fn().mockReturnValue({ __tag: "legacy-writer" } as any),
        buildLegacyReplica: vi.fn(),
      }
    );
    const warn = vi.fn();

    const enabled = computeRunOpsSplitReadEnabled({
      newReplica: topo.newRunOps.replica,
      controlPlaneWriter: topo.controlPlane.writer,
      controlPlaneReplica: topo.controlPlane.replica,
      hasNewUrl: true,
      hasLegacyUrl: true,
      logger: { warn },
    });

    expect(enabled).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("regression: both URLs set but the client factory aliases the control-plane instance -> gate FALSE, warn fires", () => {
    // Stand-in for the bug this test guards against: a builder refactor that accidentally
    // returns the shared control-plane client instead of opening a dedicated connection.
    const topo = selectRunOpsTopology(
      { splitEnabled: true, legacyUrl: "postgres://legacy", newUrl: "postgres://new" },
      {
        controlPlane: cp,
        buildNewWriter: vi.fn().mockReturnValue(cp.replica),
        buildNewReplica: vi.fn(),
        buildLegacyWriter: vi.fn().mockReturnValue({ __tag: "legacy-writer" } as any),
        buildLegacyReplica: vi.fn(),
      }
    );
    const warn = vi.fn();

    const enabled = computeRunOpsSplitReadEnabled({
      newReplica: topo.newRunOps.replica,
      controlPlaneWriter: topo.controlPlane.writer,
      controlPlaneReplica: topo.controlPlane.replica,
      hasNewUrl: true,
      hasLegacyUrl: true,
      logger: { warn },
    });

    expect(enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("single mode (URLs unset): topology naturally collapses to control-plane refs -> gate FALSE, no warn", () => {
    const topo = selectRunOpsTopology(
      { splitEnabled: false },
      {
        controlPlane: cp,
        buildNewWriter: vi.fn(),
        buildNewReplica: vi.fn(),
        buildLegacyWriter: vi.fn(),
        buildLegacyReplica: vi.fn(),
      }
    );
    const warn = vi.fn();

    const enabled = computeRunOpsSplitReadEnabled({
      newReplica: topo.newRunOps.replica,
      controlPlaneWriter: topo.controlPlane.writer,
      controlPlaneReplica: topo.controlPlane.replica,
      hasNewUrl: false,
      hasLegacyUrl: false,
      logger: { warn },
    });

    expect(enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(topo.newRunOps.replica).toBe(cp.replica); // sanity: genuinely the shared instance
  });
});
