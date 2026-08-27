import { describe, expect, it, vi } from "vitest";
import { classifyKind, mintWaitpointIdFor, resolveShard } from "@trigger.dev/core/v3/isomorphic";
import { resolveInheritedMintKind } from "./resolveInheritedMintKind.server";
import {
  mintAnchoredRunFriendlyId,
  mintFriendlyIdForKind,
} from "./mintAnchoredRunFriendlyId.server";
import { batchIdForMintKind } from "./mintBatchFriendlyId.server";
import { resolveRunMintTarget } from "./resolveRunMintTarget.server";

// The gate is off when RUN_OPS_SHARDS is unset or runOpsMintShardSet is empty; either way
// resolveMintShard answers "new". Every assertion is "the id is what it was before gen-2".
const offShard = vi.fn().mockResolvedValue("new" as const);
const environment = { organizationId: "org_1", id: "env_1", orgFeatureFlags: {} };

describe("gate off — run mint paths", () => {
  it("a root run on the run-ops path mints a gen-1 v1 id", async () => {
    const target = await resolveRunMintTarget({
      environment,
      region: "us-east-1",
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("runOpsId"),
        resolveMintShard: offShard,
      },
    });
    const body = mintFriendlyIdForKind(target).slice(4);
    expect(body.length).toBe(26);
    expect(body[24]).toBe("e"); // the region char, as today
    expect(body[25]).toBe("1");
  });

  it("a root run on a non-cut-over org mints a cuid", async () => {
    const target = await resolveRunMintTarget({
      environment,
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("cuid"),
        resolveMintShard: offShard,
      },
    });
    expect(mintFriendlyIdForKind(target).slice(4).length).toBe(25);
  });

  it("a child of a gen-1 parent keeps the caller's region char", async () => {
    // The pre-split code passed the region on both arms; dropping it on the inherited arm would
    // silently stamp the default.
    const target = await resolveRunMintTarget({
      environment,
      parentRunFriendlyId: `run_${"a".repeat(24)}01`,
      region: "us-east-1",
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("runOpsId"),
        resolveMintShard: offShard,
      },
    });
    const body = mintFriendlyIdForKind(target).slice(4);
    expect(body[24]).toBe("e");
    expect(body[25]).toBe("1");
  });

  it("a gen-2 parent's shard still outranks the caller's region", async () => {
    const target = await resolveRunMintTarget({
      environment,
      parentRunFriendlyId: `run_${"a".repeat(24)}a2`,
      region: "us-east-1",
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("runOpsId"),
        resolveMintShard: offShard,
      },
    });
    expect(mintFriendlyIdForKind(target).slice(4)[24]).toBe("a");
  });

  it("a child of a gen-1 parent mints a gen-1 v1 id", () => {
    const body = mintFriendlyIdForKind(resolveInheritedMintKind(`run_${"a".repeat(24)}01`)).slice(
      4
    );
    expect(body[25]).toBe("1");
  });

  it("a child of a cuid parent mints a cuid", () => {
    expect(
      mintFriendlyIdForKind(resolveInheritedMintKind(`run_${"b".repeat(25)}`)).slice(4).length
    ).toBe(25);
  });
});

describe("gate off — batch and item paths", () => {
  it("a batch with no shard char mints a gen-1 v1 id", () => {
    const r = batchIdForMintKind({ kind: "runOpsId" });
    expect(r.id.length).toBe(26);
    expect(r.id[25]).toBe("1");
    expect(classifyKind(r.id)).toBe("runOpsId");
  });

  it("a batch on a non-cut-over org mints a cuid", () => {
    expect(batchIdForMintKind({ kind: "cuid" }).id.length).toBe(25);
  });

  it("a batch item anchored on a gen-1 batch mints a gen-1 v1 id", () => {
    const body = mintAnchoredRunFriendlyId(`batch_${"a".repeat(24)}01`).slice(4);
    expect(body[25]).toBe("1");
  });
});

describe("gate off — waitpoint paths", () => {
  it("every gen-1 or legacy anchor yields a cuid waitpoint id", () => {
    for (const anchor of [`${"a".repeat(24)}01`, "c".repeat(25), undefined]) {
      const r = mintWaitpointIdFor(anchor);
      expect(r.id.length).toBe(25);
      expect(resolveShard(r.id)).toBe("legacy");
    }
  });
});
