import { describe, expect, it } from "vitest";
import { resolveInheritedMintKind } from "./resolveInheritedMintKind.server";
import { mintFriendlyIdForKind } from "./mintAnchoredRunFriendlyId.server";

const NEW_PARENT = `run_${"a".repeat(24)}01`; // run-ops v1 id-shape -> NEW
const LEGACY_PARENT = `run_${"b".repeat(25)}`; // cuid id-shape -> LEGACY
const GEN2_PARENT = `run_${"a".repeat(24)}a2`; // gen-2, shard "a"

describe("resolveInheritedMintKind (pure id-shape, shared across all mint paths)", () => {
  it("inherits a run-ops (NEW) parent by id-shape -> runOpsId with NO shard char", () => {
    expect(resolveInheritedMintKind(NEW_PARENT)).toEqual({ kind: "runOpsId" });
  });

  it("inherits a cuid (LEGACY) parent by id-shape -> cuid", () => {
    expect(resolveInheritedMintKind(LEGACY_PARENT)).toEqual({ kind: "cuid" });
  });

  it("inherits a gen-2 parent's shard char, never a freshly resolved one", () => {
    expect(resolveInheritedMintKind(GEN2_PARENT)).toEqual({ kind: "runOpsId", shardChar: "a" });
  });

  it("accepts the bare internal form", () => {
    expect(resolveInheritedMintKind(GEN2_PARENT.slice(4))).toEqual({
      kind: "runOpsId",
      shardChar: "a",
    });
  });
});

describe("mintFriendlyIdForKind", () => {
  it("a shard char mints a gen-2 id with that char at index 24 and '2' at 25", () => {
    const body = mintFriendlyIdForKind({ kind: "runOpsId", shardChar: "a" }).slice("run_".length);
    expect(body.length).toBe(26);
    expect(body[24]).toBe("a");
    expect(body[25]).toBe("2");
  });

  it("a shard char wins over a region: index 24 has ONE source", () => {
    const body = mintFriendlyIdForKind({
      kind: "runOpsId",
      shardChar: "a",
      region: "us-east-1",
    }).slice("run_".length);
    expect(body[24]).toBe("a"); // not "e", the us-east-1 region char
  });

  it("no shard char mints a gen-1 v1 id, stamping the region as today", () => {
    const body = mintFriendlyIdForKind({ kind: "runOpsId", region: "us-east-1" }).slice(4);
    expect(body[24]).toBe("e");
    expect(body[25]).toBe("1");
  });

  it("no shard char and no region mints a gen-1 v1 id with the default region char", () => {
    const body = mintFriendlyIdForKind({ kind: "runOpsId" }).slice(4);
    expect(body[24]).toBe("0");
    expect(body[25]).toBe("1");
  });

  it("cuid kind mints a 25-char cuid", () => {
    expect(mintFriendlyIdForKind({ kind: "cuid" }).slice(4).length).toBe(25);
  });

  it("an end-to-end inherit-then-mint keeps a child on the parent's shard", () => {
    const body = mintFriendlyIdForKind(resolveInheritedMintKind(GEN2_PARENT)).slice(4);
    expect(body[24]).toBe("a");
    expect(body[25]).toBe("2");
  });
});
