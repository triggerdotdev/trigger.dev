import { describe, expect, it } from "vitest";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  generateRunOpsIdV2,
  parseWaitpointId,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";
import { deriveRunWaitpointId } from "./runWaitpointId.js";

describe("deriveRunWaitpointId", () => {
  it("preserves native anchors, deterministically maps CUID timestamp and rejects unsupported shapes", () => {
    for (const body of [generateRunOpsId(), generateRunOpsIdV2("7"), RunId.generate().id]) {
      const id = deriveRunWaitpointId(body)!;
      expect(id).toBe(deriveRunWaitpointId(`run_${body}`));
      expect(id).toBe(deriveRunWaitpointId(body));
      const parsed = parseWaitpointId(id);
      expect(parsed.format).toBe("b32hexW");
      if (parsed.format !== "b32hexW") throw new Error("invalid native RUN identity");
      expect(parsed.type).toBe("RUN");
      if (body.length === 25) {
        expect(parsed.timestamp.getTime()).toBe(Number.parseInt(body.slice(1, 9), 36));
      } else expect(id).toBe(deriveWaitpointIdFromAnchor(body, "RUN"));
    }
    for (const invalid of [
      "",
      "run_",
      "invalid",
      `batch_${RunId.generate().id}`,
      `batch_${generateRunOpsId()}`,
      "c".repeat(24),
      "C".repeat(25),
    ]) {
      expect(deriveRunWaitpointId(invalid)).toBeUndefined();
    }
    expect(deriveRunWaitpointId("cltest00000000000000000000")).not.toBe(
      deriveRunWaitpointId("cltest00000000000000000001")
    );
  });
});
