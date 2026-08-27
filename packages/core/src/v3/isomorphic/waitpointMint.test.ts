import { describe, expect, it } from "vitest";
import { mintWaitpointIdFor, mintWaitpointIdForShard } from "./waitpointMint.js";
import {
  generateRunOpsId,
  generateRunOpsIdV2,
  isValidShardChar,
  parseRunOpsIdBody,
  parseRunOpsIdV2Body,
} from "./friendlyId.js";
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

describe("resolveShard shape checks match the decoding parsers", () => {
  // Pins the shape/decode equivalence: a drift misroutes rather than erroring.
  const classifyByDecode = (body: string): string => {
    const genTwo = parseRunOpsIdV2Body(body);
    if (genTwo) return genTwo.shard;
    return parseRunOpsIdBody(body) !== undefined ? "new" : "legacy";
  };

  it("agrees on freshly minted gen-1 and gen-2 bodies", () => {
    for (let i = 0; i < 500; i++) {
      const one = generateRunOpsId();
      const two = generateRunOpsIdV2("abcdefghijklmnopqrstuvwxyz0123456789"[i % 36]!);
      expect(resolveShard(one)).toBe(classifyByDecode(one));
      expect(resolveShard(two)).toBe(classifyByDecode(two));
    }
  });

  it("agrees on 26-char strings carrying out-of-alphabet characters", () => {
    const alpha = "0123456789abcdefghijklmnopqrstuvwxyz-_.ZW!";
    for (let i = 0; i < 2000; i++) {
      let s = "";
      for (let j = 0; j < 26; j++) s += alpha[(i * 7 + j * 13) % alpha.length];
      for (const body of [s, s.slice(0, 25) + "1", s.slice(0, 25) + "2"]) {
        expect({ body, shape: resolveShard(body) }).toEqual({
          body,
          shape: classifyByDecode(body),
        });
      }
    }
  });

  it("agrees on the shapes the plan pins as legacy", () => {
    for (const body of ["", "a", "a".repeat(25), "a".repeat(27), `${"a".repeat(24)}e2`]) {
      expect(resolveShard(body)).toBe(classifyByDecode(body));
    }
  });
});
