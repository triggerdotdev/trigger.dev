import { describe, expect, it, vi } from "vitest";
import {
  batchIdForMintKind,
  mintBatchFriendlyId,
  resolveBatchMintKind,
} from "./mintBatchFriendlyId.server";
import { classifyKind } from "@trigger.dev/core/v3/isomorphic";
import { MEMORYDB_SHARD_KEY } from "@internal/run-store";

describe("batchIdForMintKind (pure)", () => {
  it("'runOpsId' kind -> 26-char classifiable NEW batch id (no 21-char ids)", () => {
    const r = batchIdForMintKind({ kind: "runOpsId" });
    expect(r.friendlyId.startsWith("batch_")).toBe(true);
    expect(r.id.length).toBe(26);
    expect(classifyKind(r.id)).toBe("runOpsId");
    expect(classifyKind(r.friendlyId)).toBe("runOpsId");
  });

  it("a shard char mints a gen-2 batch id carrying that char", () => {
    const r = batchIdForMintKind({ kind: "runOpsId", shardChar: "a" });
    expect(r.id.length).toBe(26);
    expect(r.id[24]).toBe("a");
    expect(r.id[25]).toBe("2");
    expect(classifyKind(r.id)).toBe("runOpsId");
  });

  // Catches: the MemoryDB key minting a batch id of a shape other than a generation 3 run id.
  it("the MemoryDB key mints a generation 3 batch id", () => {
    const r = batchIdForMintKind({ kind: "runOpsId", shardChar: MEMORYDB_SHARD_KEY });
    expect(r.id).toMatch(/^[a-z0-9]{24}m2$/);
    expect(r.friendlyId).toBe(`batch_${r.id}`);
  });

  it("cuid -> 25-char classifiable LEGACY batch id", () => {
    const r = batchIdForMintKind({ kind: "cuid" });
    expect(r.id.length).toBe(25);
    expect(classifyKind(r.id)).toBe("cuid");
    expect(classifyKind(r.friendlyId)).toBe("cuid");
  });

  it("never mints a 21-char id", () => {
    for (const kind of ["cuid", "runOpsId"] as const) {
      expect([25, 26]).toContain(batchIdForMintKind({ kind }).id.length);
    }
  });
});

describe("resolveBatchMintKind", () => {
  const environment = { organizationId: "org_1", id: "env_1", orgFeatureFlags: {} };
  const NEW_PARENT = `run_${"a".repeat(24)}01`;
  const LEGACY_PARENT = `run_${"a".repeat(25)}`;
  const GEN2_PARENT = `run_${"a".repeat(24)}a2`;

  it("ROOT batch (no parent) resolves per-org kind via resolveRunIdMintKind", async () => {
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("runOpsId");
    const resolveMintShard = vi.fn().mockResolvedValue("new");
    const target = await resolveBatchMintKind({
      environment,
      deps: { resolveRunIdMintKind, resolveMintShard },
    });
    expect(target.kind).toBe("runOpsId");
    expect(target.shardChar).toBeUndefined();
    expect(resolveRunIdMintKind).toHaveBeenCalledWith({
      organizationId: "org_1",
      id: "env_1",
      orgFeatureFlags: {},
    });
  });

  it("ROOT batch mints by the mint policy when a shard is active", async () => {
    const target = await resolveBatchMintKind({
      environment,
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("runOpsId"),
        resolveMintShard: vi.fn().mockResolvedValue("a"),
      },
    });
    expect(target).toEqual({ kind: "runOpsId", shardChar: "a", region: undefined });
  });

  it("ROOT batch on a non-cut-over org -> cuid", async () => {
    const target = await resolveBatchMintKind({
      environment,
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("cuid"),
        resolveMintShard: vi.fn(),
      },
    });
    expect(target.kind).toBe("cuid");
  });

  it("CHILD batch inherits a run-ops (NEW) parent by id-shape", async () => {
    const resolveRunIdMintKind = vi.fn();
    const target = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId: NEW_PARENT,
      deps: { resolveRunIdMintKind, resolveMintShard: vi.fn() },
    });
    expect(target).toEqual({ kind: "runOpsId" });
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });

  it("CHILD batch takes a gen-2 parent's shard char", async () => {
    const resolveRunIdMintKind = vi.fn();
    const resolveMintShard = vi.fn();
    const target = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId: GEN2_PARENT,
      deps: { resolveRunIdMintKind, resolveMintShard },
    });
    expect(target).toEqual({ kind: "runOpsId", shardChar: "a" });
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
    expect(resolveMintShard).not.toHaveBeenCalled();
  });

  it("CHILD batch inherits a cuid (LEGACY) parent by id-shape", async () => {
    const resolveRunIdMintKind = vi.fn();
    const target = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId: LEGACY_PARENT,
      deps: { resolveRunIdMintKind, resolveMintShard: vi.fn() },
    });
    expect(target).toEqual({ kind: "cuid" });
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });

  // mint-on-FLIP invariant: a child follows its parent's store even after the org flag
  // flips the other way. The flag resolver must NEVER be consulted for a child.
  it("FLIP 'cuid'->'runOpsId': a cuid (LEGACY) parent still mints a cuid child though the flag now says 'runOpsId'", async () => {
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("runOpsId"); // flag flipped to runOpsId
    const target = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId: LEGACY_PARENT,
      deps: { resolveRunIdMintKind, resolveMintShard: vi.fn() },
    });
    expect(target).toEqual({ kind: "cuid" });
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });

  it("FLIP 'runOpsId'->'cuid': a run-ops (NEW) parent still mints a run-ops child though the flag now says 'cuid'", async () => {
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("cuid"); // flag flipped back to cuid
    const target = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId: NEW_PARENT,
      deps: { resolveRunIdMintKind, resolveMintShard: vi.fn() },
    });
    expect(target).toEqual({ kind: "runOpsId" });
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
  });

  it("FLIP does not move a gen-2 child off its parent's shard", async () => {
    const target = await resolveBatchMintKind({
      environment,
      parentRunFriendlyId: GEN2_PARENT,
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("cuid"),
        resolveMintShard: vi.fn().mockResolvedValue("b"),
      },
    });
    expect(target).toEqual({ kind: "runOpsId", shardChar: "a" });
  });
});

describe("mintBatchFriendlyId", () => {
  // Catches: a composed batch mint that stops inheriting a gen-2 parent's shard or asks the org setting.
  it("mints a batch id on a gen-2 parent's shard without asking either resolver", async () => {
    const resolveRunIdMintKind = vi.fn();
    const resolveMintShard = vi.fn();
    for (const shard of ["a", "c"]) {
      const minted = await mintBatchFriendlyId({
        environment: { organizationId: "org_1", id: "env_1", orgFeatureFlags: {} },
        parentRunFriendlyId: `run_${"a".repeat(24)}${shard}2`,
        deps: { resolveRunIdMintKind, resolveMintShard },
      });

      expect(minted.id[24]).toBe(shard);
      expect(minted.id[25]).toBe("2");
      expect(minted.friendlyId.startsWith("batch_")).toBe(true);
    }
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
    expect(resolveMintShard).not.toHaveBeenCalled();
  });
});
