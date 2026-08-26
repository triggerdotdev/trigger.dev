import { describe, expect, it } from "vitest";
import { mintWaitpointIdFor, resolveShard } from "@trigger.dev/core/v3/isomorphic";

// The mint is pure, so each site's stamping is asserted without a container. The write
// behaviour itself is covered by the coordinator's own suite.
const GEN2_RUN = `${"a".repeat(24)}a2`;
const GEN1_RUN = `${"a".repeat(24)}01`;
const CUID_RUN = "c".repeat(25);

describe("DATETIME and MANUAL waitpoint ids", () => {
  it("a gen-2 run anchor stamps that run's shard char", () => {
    const r = mintWaitpointIdFor(GEN2_RUN);
    expect(r.id[24]).toBe("a");
    expect(r.id[25]).toBe("2");
  });

  it("a gen-1 run anchor keeps a cuid", () => {
    expect(mintWaitpointIdFor(GEN1_RUN).id.length).toBe(25);
  });

  it("a cuid run anchor keeps a cuid", () => {
    expect(mintWaitpointIdFor(CUID_RUN).id.length).toBe(25);
  });

  it("each retry attempt mints a distinct id on the same shard", () => {
    const first = mintWaitpointIdFor(GEN2_RUN);
    const second = mintWaitpointIdFor(GEN2_RUN);
    expect(first.id).not.toBe(second.id);
    expect(first.id[24]).toBe("a");
    expect(second.id[24]).toBe("a");
  });
});

describe("the RUN-associated waitpoint", () => {
  // This row is written inside the run store, which has no stamp check. A cuid here lands
  // on a gen-2 shard, the completion fallback probes only the gen-1 pair, and the parent
  // waits forever with no error. So the anchor must reach the mint.
  it("stamps the run's shard char when the run is gen-2", () => {
    const r = mintWaitpointIdFor(GEN2_RUN);
    expect(r.id[24]).toBe("a");
    expect(r.id[25]).toBe("2");
  });

  it("keeps a cuid for a gen-1 run, which is today's behaviour", () => {
    expect(mintWaitpointIdFor(GEN1_RUN).id.length).toBe(25);
  });

  it("mints a fresh core, so the waitpoint id never equals the run's own body", () => {
    expect(mintWaitpointIdFor(GEN2_RUN).id).not.toBe(GEN2_RUN);
  });
});

describe("the BATCH waitpoint", () => {
  const GEN2_BATCH = `${"d".repeat(24)}a2`;

  // The create passes only completedByBatchId, so the routing store resolves the owner
  // from the BATCH and validates the stamp against the batch's shard. Stamping from the
  // run would throw. The two agree structurally: the batch is minted from the same parent
  // run id that is then blocked, in the same request.
  it("stamps the batch's shard char", () => {
    expect(mintWaitpointIdFor(GEN2_BATCH).id[24]).toBe("a");
  });

  it("the batch's shard equals the blocked run's shard", () => {
    expect(resolveShard(GEN2_BATCH)).toBe(resolveShard(GEN2_RUN));
  });

  it("a gen-1 batch keeps a cuid", () => {
    expect(mintWaitpointIdFor(`${"d".repeat(24)}01`).id.length).toBe(25);
  });
});
