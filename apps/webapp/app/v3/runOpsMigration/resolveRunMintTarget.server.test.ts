import { describe, expect, it, vi } from "vitest";
import { resolveRunMintTarget } from "./resolveRunMintTarget.server";

const environment = { organizationId: "org_1", id: "env_1", orgFeatureFlags: {} };
const GEN2_PARENT = `run_${"a".repeat(24)}a2`;
const LEGACY_PARENT = `run_${"b".repeat(25)}`;

describe("resolveRunMintTarget — root", () => {
  it("resolves the kind, then the shard, and returns both", async () => {
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("runOpsId");
    const resolveMintShard = vi.fn().mockResolvedValue("a");

    const target = await resolveRunMintTarget({
      environment,
      deps: { resolveRunIdMintKind, resolveMintShard },
    });

    expect(target).toEqual({ kind: "runOpsId", shardChar: "a", region: undefined });
    expect(resolveMintShard).toHaveBeenCalledWith({ id: "env_1", orgFeatureFlags: {} });
  });

  it("a 'new' shard result carries NO shard char, so the mint stays gen-1", async () => {
    const target = await resolveRunMintTarget({
      environment,
      region: "us-east-1",
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("runOpsId"),
        resolveMintShard: vi.fn().mockResolvedValue("new"),
      },
    });
    expect(target).toEqual({ kind: "runOpsId", region: "us-east-1" });
  });

  it("never resolves a shard when the kind is cuid", async () => {
    const resolveMintShard = vi.fn();
    const target = await resolveRunMintTarget({
      environment,
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("cuid"),
        resolveMintShard,
      },
    });
    expect(target).toEqual({ kind: "cuid" });
    expect(resolveMintShard).not.toHaveBeenCalled();
  });
});

describe("resolveRunMintTarget — child", () => {
  it("inherits a gen-2 parent's shard and consults NEITHER resolver", async () => {
    const resolveRunIdMintKind = vi.fn();
    const resolveMintShard = vi.fn();

    const target = await resolveRunMintTarget({
      environment,
      parentRunFriendlyId: GEN2_PARENT,
      deps: { resolveRunIdMintKind, resolveMintShard },
    });

    expect(target).toEqual({ kind: "runOpsId", shardChar: "a" });
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
    expect(resolveMintShard).not.toHaveBeenCalled();
  });

  it("a cuid parent still yields cuid though the flag now says runOpsId", async () => {
    const target = await resolveRunMintTarget({
      environment,
      parentRunFriendlyId: LEGACY_PARENT,
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("runOpsId"),
        resolveMintShard: vi.fn().mockResolvedValue("a"),
      },
    });
    expect(target).toEqual({ kind: "cuid" });
  });
});
