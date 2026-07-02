import { describe, expect, it, vi } from "vitest";
import { batchIdForMintKind, resolveBatchMintKind } from "./mintBatchFriendlyId.server";
import { classifyKind } from "@trigger.dev/core/v3/isomorphic";

describe("batchIdForMintKind (pure)", () => {
  it("ksuid -> 27-char classifiable NEW batch id (no 21-char ids)", () => {
    const r = batchIdForMintKind("ksuid");
    expect(r.friendlyId.startsWith("batch_")).toBe(true);
    expect(r.id.length).toBe(27);
    expect(classifyKind(r.id)).toBe("ksuid");
    expect(classifyKind(r.friendlyId)).toBe("ksuid");
  });

  it("cuid -> 25-char classifiable LEGACY batch id", () => {
    const r = batchIdForMintKind("cuid");
    expect(r.id.length).toBe(25);
    expect(classifyKind(r.id)).toBe("cuid");
    expect(classifyKind(r.friendlyId)).toBe("cuid");
  });

  it("never mints a 21-char id", () => {
    for (const kind of ["cuid", "ksuid"] as const) {
      expect([25, 27]).toContain(batchIdForMintKind(kind).id.length);
    }
  });
});

describe("resolveBatchMintKind", () => {
  const environment = { organizationId: "org_1", id: "env_1", orgFeatureFlags: {} };

  it("ROOT batch (no parent) resolves per-org kind via resolveRunIdMintKind", async () => {
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("ksuid");
    const kind = await resolveBatchMintKind({
      environment,
      deps: { resolveRunIdMintKind },
    });
    expect(kind).toBe("ksuid");
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

  it("CHILD batch inherits a ksuid (NEW) parent by id-shape", async () => {
    const parentRunFriendlyId = `run_${"a".repeat(27)}`;
    const resolveRunIdMintKind = vi.fn();

    const kind = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId,
      deps: { resolveRunIdMintKind },
    });

    expect(kind).toBe("ksuid");
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
  it("FLIP cuid->ksuid: a cuid (LEGACY) parent still mints a cuid child though the flag now says ksuid", async () => {
    const parentRunFriendlyId = `run_${"a".repeat(25)}`;
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("ksuid"); // flag flipped to ksuid
    const kind = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId,
      deps: { resolveRunIdMintKind },
    });
    expect(kind).toBe("cuid");
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });

  it("FLIP ksuid->cuid: a ksuid (NEW) parent still mints a ksuid child though the flag now says cuid", async () => {
    const parentRunFriendlyId = `run_${"a".repeat(27)}`;
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("cuid"); // flag flipped back to cuid
    const kind = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId,
      deps: { resolveRunIdMintKind },
    });
    expect(kind).toBe("ksuid");
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });
});
