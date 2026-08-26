import { describe, expect, it } from "vitest";
import { mintWaitpointIdFor, mintWaitpointIdForShard } from "./waitpointMint.js";
import { isValidShardChar, parseRunOpsIdV2Body } from "./friendlyId.js";
import { resolveShard } from "./runOpsResidency.js";

const GEN2_RUN = `run_${"a".repeat(24)}a2`; // shard "a", version "2"
const GEN1_RUN = `run_${"a".repeat(24)}01`; // region "0", version "1"
const CUID_RUN = `run_${"b".repeat(25)}`;

describe("mintWaitpointIdForShard", () => {
  it("a gen-2 shard key mints a gen-2 body with that char at index 24", () => {
    const r = mintWaitpointIdForShard("a");
    expect(r.id.length).toBe(26);
    expect(r.id[24]).toBe("a");
    expect(r.id[25]).toBe("2");
    expect(r.friendlyId).toBe(`waitpoint_${r.id}`);
    expect(parseRunOpsIdV2Body(r.id)?.shard).toBe("a");
  });

  it("the reserved key 'new' mints a cuid, unchanged from today", () => {
    const r = mintWaitpointIdForShard("new");
    expect(r.id.length).toBe(25);
    expect(resolveShard(r.id)).toBe("legacy");
  });

  it("the reserved key 'legacy' mints a cuid", () => {
    expect(mintWaitpointIdForShard("legacy").id.length).toBe(25);
  });

  it("two calls for one shard never collide", () => {
    expect(mintWaitpointIdForShard("a").id).not.toBe(mintWaitpointIdForShard("a").id);
  });

  it("every gen-2 id it mints routes back to its own shard", () => {
    for (const key of ["a", "b", "0", "z", "9"]) {
      expect(isValidShardChar(key)).toBe(true);
      expect(resolveShard(mintWaitpointIdForShard(key).id)).toBe(key);
    }
  });
});

describe("mintWaitpointIdFor", () => {
  it("a gen-2 anchor stamps the anchor's shard char", () => {
    const r = mintWaitpointIdFor(GEN2_RUN);
    expect(r.id[24]).toBe("a");
    expect(r.id[25]).toBe("2");
  });

  it("a gen-2 anchor yields a FRESH core, never the anchor's own body", () => {
    const r = mintWaitpointIdFor(GEN2_RUN);
    expect(r.id).not.toBe(GEN2_RUN.slice(4));
    expect(r.id.slice(0, 24)).not.toBe("a".repeat(24));
  });

  it("accepts the bare internal form as well as the prefixed form", () => {
    expect(mintWaitpointIdFor(GEN2_RUN.slice(4)).id[24]).toBe("a");
  });

  it("a gen-1 v1 anchor mints a cuid", () => {
    expect(mintWaitpointIdFor(GEN1_RUN).id.length).toBe(25);
  });

  it("a cuid anchor mints a cuid", () => {
    expect(mintWaitpointIdFor(CUID_RUN).id.length).toBe(25);
  });

  it("no anchor mints a cuid", () => {
    expect(mintWaitpointIdFor(undefined).id.length).toBe(25);
  });
});
