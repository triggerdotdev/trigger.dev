import { describe, expect, it } from "vitest";
import {
  formatComputeCheckpointLocation,
  parseComputeCheckpointLocation,
  validateCheckpointLocation,
} from "./checkpointLocation.js";

const SNAPSHOT = "0b6f0c8e-2d1a-4b7e-9f3c-5a8d2e1f4c7b";

describe("parseComputeCheckpointLocation", () => {
  // Catches: the supervisor writing a COMPUTE location its own restore can't parse back.
  it("round-trips with format", () => {
    const location = formatComputeCheckpointLocation({ node: "node-a", snapshotID: SNAPSHOT });
    expect(parseComputeCheckpointLocation(location)).toEqual({
      ok: true,
      value: { node: "node-a", snapshotID: SNAPSHOT },
    });
  });

  // Catches: a location the restore side can't parse being stored as a COMPUTE checkpoint.
  it.each([
    ["a scheme-prefixed string", "foo://bar-123"],
    ["no separator", SNAPSHOT],
    ["an extra segment", `node-a/${SNAPSHOT}/x`],
    ["an empty node", `/${SNAPSHOT}`],
    ["an empty snapshot", "node-a/"],
    ["an uppercase node", `Node-A/${SNAPSHOT}`],
    ["a node ending in a dash", `node-/${SNAPSHOT}`],
    ["a snapshot starting with a dash", "node-a/-snap"],
    ["a dot in the snapshot", "node-a/.."],
    ["whitespace", `node-a/${SNAPSHOT}\n`],
    ["an oversized node", `${"a".repeat(254)}/${SNAPSHOT}`],
    ["an empty node label", `node-..a/${SNAPSHOT}`],
    ["a node label ending in a dash", `node-.a/${SNAPSHOT}`],
    ["a node ending in a dot", `node-a./${SNAPSHOT}`],
    ["a node label over 63 chars", `${"a".repeat(64)}/${SNAPSHOT}`],
    ["an oversized snapshot", `node-a/${"a".repeat(129)}`],
  ])("refuses %s", (_, location) => {
    expect(parseComputeCheckpointLocation(location).ok).toBe(false);
  });

  // Catches: an over-tight bound refusing the longest node names and snapshot ids the operator allows.
  it("accepts the longest node and snapshot", () => {
    const node = [63, 63, 63, 61].map((n) => "a".repeat(n)).join(".");
    expect(node).toHaveLength(253);
    expect(parseComputeCheckpointLocation(`${node}/${"b".repeat(128)}`).ok).toBe(true);
  });
});

describe("validateCheckpointLocation", () => {
  // Catches: a non-COMPUTE location with control characters, whitespace or no length bound being stored.
  it.each([
    ["empty", ""],
    ["whitespace", "a b"],
    ["a newline", "a\nb"],
    ["a control character", "a\u0000b"],
    ["non-ASCII", "café"],
    ["oversized", "a".repeat(1025)],
  ])("refuses a KUBERNETES location that is %s", (_, location) => {
    expect(validateCheckpointLocation({ type: "KUBERNETES", location }).ok).toBe(false);
  });
});
