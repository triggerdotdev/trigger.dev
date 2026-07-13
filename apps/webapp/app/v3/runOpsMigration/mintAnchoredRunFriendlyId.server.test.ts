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
});
