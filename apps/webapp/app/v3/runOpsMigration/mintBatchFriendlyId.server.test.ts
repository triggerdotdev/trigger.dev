import { describe, expect, it, vi } from "vitest";
import { batchIdForMintKind, resolveBatchMintKind } from "./mintBatchFriendlyId.server";
import { classifyKind } from "@trigger.dev/core/v3/isomorphic";

describe("batchIdForMintKind (pure)", () => {
  it("'runOpsId' kind -> 26-char classifiable NEW batch id (no 21-char ids)", () => {
    const r = batchIdForMintKind("runOpsId");
    expect(r.friendlyId.startsWith("batch_")).toBe(true);
    expect(r.id.length).toBe(26);
    expect(classifyKind(r.id)).toBe("runOpsId");
    expect(classifyKind(r.friendlyId)).toBe("runOpsId");
  });

  it("cuid -> 25-char classifiable LEGACY batch id", () => {
    const r = batchIdForMintKind("cuid");
    expect(r.id.length).toBe(25);
    expect(classifyKind(r.id)).toBe("cuid");
    expect(classifyKind(r.friendlyId)).toBe("cuid");
  });

  it("never mints a 21-char id", () => {
    for (const kind of ["cuid", "runOpsId"] as const) {
      expect([25, 26]).toContain(batchIdForMintKind(kind).id.length);
    }
  });
});

describe("resolveBatchMintKind", () => {
  const environment = { organizationId: "org_1", id: "env_1", orgFeatureFlags: {} };

  it("ROOT batch (no parent) resolves per-org kind via resolveRunIdMintKind", async () => {
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("runOpsId");
    const kind = await resolveBatchMintKind({
      environment,
      deps: { resolveRunIdMintKind },
    });
    expect(kind).toBe("runOpsId");
    expect(resolveRunIdMintKind).toHaveBeenCalledWith({
      organizationId: "org_1",
      id: "env_1",
      orgFeatureFlags: {},
    });
  });

  it("ROOT batch on a non-cut-over org -> cuid", async () => {
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("cuid");
    const kind = await resolveBatchMintKind({
      environment,
      deps: { resolveRunIdMintKind },
    });
    expect(kind).toBe("cuid");
  });

  it("CHILD batch inherits a run-ops (NEW) parent by id-shape", async () => {
    const parentRunFriendlyId = `run_${"a".repeat(24) + "01"}`;
    const resolveRunIdMintKind = vi.fn();

    const kind = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId,
      deps: { resolveRunIdMintKind },
    });

    expect(kind).toBe("runOpsId");
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });

  it("CHILD batch inherits a cuid (LEGACY) parent by id-shape", async () => {
    const parentRunFriendlyId = `run_${"a".repeat(25)}`;
    const resolveRunIdMintKind = vi.fn();

    const kind = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId,
      deps: { resolveRunIdMintKind },
    });

    expect(kind).toBe("cuid");
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });

  // mint-on-FLIP invariant: a child follows its parent's store even after the org flag
  // flips the other way. The flag resolver must NEVER be consulted for a child.
  it("FLIP 'cuid'->'runOpsId': a cuid (LEGACY) parent still mints a cuid child though the flag now says 'runOpsId'", async () => {
    const parentRunFriendlyId = `run_${"a".repeat(25)}`;
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("runOpsId"); // flag flipped to runOpsId
    const kind = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId,
      deps: { resolveRunIdMintKind },
    });
    expect(kind).toBe("cuid");
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });

  it("FLIP 'runOpsId'->'cuid': a run-ops (NEW) parent still mints a run-ops child though the flag now says 'cuid'", async () => {
    const parentRunFriendlyId = `run_${"a".repeat(24) + "01"}`;
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("cuid"); // flag flipped back to cuid
    const kind = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId,
      deps: { resolveRunIdMintKind },
    });
    expect(kind).toBe("runOpsId");
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });
});
