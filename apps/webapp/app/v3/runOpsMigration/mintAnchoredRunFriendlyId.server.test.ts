import {
  BatchId,
  classifyKind,
  generateRunOpsId,
  parseRunId,
  REGION_CODES,
} from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it } from "vitest";
import { mintAnchoredRunFriendlyId } from "./mintAnchoredRunFriendlyId.server";

describe("mintAnchoredRunFriendlyId", () => {
  it("a run-ops (NEW) batch anchor yields a run-ops (NEW) item friendlyId", () => {
    const batchFriendlyId = BatchId.toFriendlyId(generateRunOpsId());
    const itemFriendlyId = mintAnchoredRunFriendlyId(batchFriendlyId);
    expect(classifyKind(itemFriendlyId)).toBe("runOpsId");
  });

  it("a cuid (LEGACY) batch anchor yields a cuid (LEGACY) item friendlyId", () => {
    const batchFriendlyId = BatchId.generate().friendlyId;
    const itemFriendlyId = mintAnchoredRunFriendlyId(batchFriendlyId);
    expect(classifyKind(itemFriendlyId)).toBe("cuid");
  });

  it("stamps the requested region char into a run-ops id", () => {
    const batchFriendlyId = BatchId.toFriendlyId(generateRunOpsId());
    const itemFriendlyId = mintAnchoredRunFriendlyId(batchFriendlyId, "us-east-1");
    const parsed = parseRunId(itemFriendlyId);
    expect(parsed.format).toBe("b32hex");
    expect(parsed.format === "b32hex" && parsed.region).toBe(REGION_CODES["us-east-1"]);
  });

  it("a gen-2 batch anchor mints an item on the batch's shard", () => {
    const body = mintAnchoredRunFriendlyId(`batch_${"a".repeat(24)}a2`).slice("run_".length);
    expect(body).toHaveLength(26);
    expect(body[24]).toBe("a");
    expect(body[25]).toBe("2");
  });

  it("a gen-2 batch anchor ignores a caller region: the shard owns index 24", () => {
    const body = mintAnchoredRunFriendlyId(`batch_${"a".repeat(24)}a2`, "us-east-1").slice(4);
    expect(body[24]).toBe("a");
  });
});
