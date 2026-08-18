import { describe, it, expect } from "vitest";
import {
  BoolEnv,
  AdditionalEnvVars,
  NodeLabelValue,
  OrgPlacementOverrides,
  Tolerations,
} from "./envUtil.js";

describe("BoolEnv", () => {
  it("should parse string 'true' as true", () => {
    expect(BoolEnv.parse("true")).toBe(true);
    expect(BoolEnv.parse("TRUE")).toBe(true);
    expect(BoolEnv.parse("True")).toBe(true);
  });

  it("should parse string '1' as true", () => {
    expect(BoolEnv.parse("1")).toBe(true);
  });

  it("should parse string 'false' as false", () => {
    expect(BoolEnv.parse("false")).toBe(false);
    expect(BoolEnv.parse("FALSE")).toBe(false);
    expect(BoolEnv.parse("False")).toBe(false);
  });

  it("should handle whitespace", () => {
    expect(BoolEnv.parse(" true ")).toBe(true);
    expect(BoolEnv.parse(" 1 ")).toBe(true);
  });

  it("should pass through boolean values", () => {
    expect(BoolEnv.parse(true)).toBe(true);
    expect(BoolEnv.parse(false)).toBe(false);
  });

  it("should return false for invalid inputs", () => {
    expect(BoolEnv.parse("invalid")).toBe(false);
    expect(BoolEnv.parse("")).toBe(false);
  });
});

describe("AdditionalEnvVars", () => {
  it("should parse single key-value pair", () => {
    expect(AdditionalEnvVars.parse("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("should parse multiple key-value pairs", () => {
    expect(AdditionalEnvVars.parse("FOO=bar,BAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should handle whitespace", () => {
    expect(AdditionalEnvVars.parse(" FOO = bar , BAZ = qux ")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should return undefined for empty string", () => {
    expect(AdditionalEnvVars.parse("")).toBeUndefined();
  });

  it("should return undefined for invalid format", () => {
    expect(AdditionalEnvVars.parse("invalid")).toBeUndefined();
  });

  it("should skip invalid pairs but include valid ones", () => {
    expect(AdditionalEnvVars.parse("FOO=bar,INVALID,BAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should pass through undefined", () => {
    expect(AdditionalEnvVars.parse(undefined)).toBeUndefined();
  });

  it("should handle empty values", () => {
    expect(AdditionalEnvVars.parse("FOO=,BAR=value")).toEqual({
      BAR: "value",
    });
  });
});

describe("NodeLabelValue", () => {
  it("should keep a clean value untouched", () => {
    expect(NodeLabelValue.parse("v4-worker")).toBe("v4-worker");
  });

  it("should trim surrounding whitespace, which Kubernetes would reject", () => {
    expect(NodeLabelValue.parse(" v4-worker ")).toBe("v4-worker");
    expect(NodeLabelValue.parse("\tv4-worker\n")).toBe("v4-worker");
  });

  it("should treat a whitespace-only value as the empty off-switch", () => {
    expect(NodeLabelValue.parse("")).toBe("");
    expect(NodeLabelValue.parse("   ")).toBe("");
  });

  it("should still apply a default only when unset", () => {
    const withDefault = NodeLabelValue.default("v4-worker");
    expect(withDefault.parse(undefined)).toBe("v4-worker");
    expect(withDefault.parse("")).toBe("");
  });

  it("should reject a value Kubernetes would reject, rather than 422 every pod create", () => {
    for (const invalid of ["my worker", "-bad-", "bad.", "a".repeat(64)]) {
      expect(NodeLabelValue.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("Tolerations", () => {
  it("should parse key=value entries as Equal", () => {
    expect(Tolerations.parse("dedicated=runs:NoSchedule")).toEqual([
      { key: "dedicated", operator: "Equal", value: "runs", effect: "NoSchedule" },
    ]);
  });

  it("should parse entries without a value as Exists", () => {
    expect(Tolerations.parse("scheduled-runs:NoExecute")).toEqual([
      { key: "scheduled-runs", operator: "Exists", effect: "NoExecute" },
    ]);
  });

  it("should keep an empty value as an exact match for a valueless taint", () => {
    expect(Tolerations.parse("dedicated=:NoSchedule")).toEqual([
      { key: "dedicated", operator: "Equal", value: "", effect: "NoSchedule" },
    ]);

    expect(Tolerations.parse("dedicated:NoSchedule")).toEqual([
      { key: "dedicated", operator: "Exists", effect: "NoSchedule" },
    ]);
  });

  it("should parse an empty string as no tolerations", () => {
    expect(Tolerations.parse("")).toEqual([]);
    expect(Tolerations.parse("  ")).toEqual([]);
  });

  it("should skip blank entries and trim whitespace", () => {
    expect(Tolerations.parse(" a=b:NoSchedule , ,")).toEqual([
      { key: "a", operator: "Equal", value: "b", effect: "NoSchedule" },
    ]);
  });

  it("should reject a missing effect, an unknown effect, and an empty key", () => {
    for (const invalid of ["dedicated=runs", "dedicated=runs:Nope", "=runs:NoSchedule"]) {
      expect(Tolerations.safeParse(invalid).success).toBe(false);
    }
  });

  it("should accept a hyphenated key, a digit-suffixed key, and every effect", () => {
    expect(
      Tolerations.parse("capacity-1=true:PreferNoSchedule,spot:NoExecute,gpu=a10:NoSchedule")
    ).toEqual([
      { key: "capacity-1", operator: "Equal", value: "true", effect: "PreferNoSchedule" },
      { key: "spot", operator: "Exists", effect: "NoExecute" },
      { key: "gpu", operator: "Equal", value: "a10", effect: "NoSchedule" },
    ]);
  });

  it("should accept a DNS-subdomain prefixed key", () => {
    expect(
      Tolerations.parse("node.cluster.x-k8s.io/machinepool=scheduled-runs:NoSchedule")
    ).toEqual([
      {
        key: "node.cluster.x-k8s.io/machinepool",
        operator: "Equal",
        value: "scheduled-runs",
        effect: "NoSchedule",
      },
    ]);
  });

  it("should reject a key or value that Kubernetes would reject at pod create", () => {
    for (const invalid of [
      "dedicated=prod runs:NoSchedule",
      "ded icated=runs:NoSchedule",
      "dedicated=-runs:NoSchedule",
      `dedicated=${"r".repeat(64)}:NoSchedule`,
      `${"a".repeat(64)}=runs:NoSchedule`,
      `example.com/${"a".repeat(64)}=runs:NoSchedule`,
      "a/b/c=runs:NoSchedule",
      "Example.com/pool=runs:NoSchedule",
    ]) {
      expect(Tolerations.safeParse(invalid).success).toBe(false);
    }
  });

  it("should bound the prefix and the name separately, as Kubernetes does", () => {
    const longestPrefix = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(longestPrefix.length).toBe(253);

    expect(Tolerations.parse(`${longestPrefix}/${"n".repeat(63)}=runs:NoSchedule`)).toHaveLength(1);
    expect(Tolerations.safeParse(`${longestPrefix}a/pool=runs:NoSchedule`).success).toBe(false);
  });

  it("should tolerate whitespace around the separators", () => {
    expect(Tolerations.parse("dedicated = runs : NoSchedule")).toEqual([
      { key: "dedicated", operator: "Equal", value: "runs", effect: "NoSchedule" },
    ]);
  });

  it("should reject a stray extra effect instead of folding it into the value", () => {
    expect(Tolerations.safeParse("dedicated=runs:NoSchedule:NoExecute").success).toBe(false);
  });
});

describe("OrgPlacementOverrides", () => {
  it("should parse a full override with nodeSelector and tolerations", () => {
    expect(
      OrgPlacementOverrides.parse(
        JSON.stringify({
          org_123: {
            nodeSelector: { "node.cluster.x-k8s.io/machinepool": "dedicated-pool" },
            tolerations: "dedicated=pool:NoSchedule",
          },
        })
      )
    ).toEqual({
      org_123: {
        nodeSelector: { "node.cluster.x-k8s.io/machinepool": "dedicated-pool" },
        tolerations: [
          { key: "dedicated", operator: "Equal", value: "pool", effect: "NoSchedule" },
        ],
      },
    });
  });

  it("should allow either half to be omitted", () => {
    expect(
      OrgPlacementOverrides.parse(JSON.stringify({ org_123: { nodeSelector: { pool: "a" } } }))
    ).toEqual({ org_123: { nodeSelector: { pool: "a" } } });

    expect(
      OrgPlacementOverrides.parse(JSON.stringify({ org_123: { tolerations: "spot:NoExecute" } }))
    ).toEqual({
      org_123: { tolerations: [{ key: "spot", operator: "Exists", effect: "NoExecute" }] },
    });

    expect(OrgPlacementOverrides.parse(JSON.stringify({ org_123: {} }))).toEqual({ org_123: {} });
  });

  it("should reject invalid JSON at startup rather than silently skipping the override", () => {
    for (const invalid of ["not json", "[]", '"org_123"', "{"]) {
      expect(OrgPlacementOverrides.safeParse(invalid).success).toBe(false);
    }
  });

  it("should reject an unknown field, so a typo cannot silently drop an override", () => {
    expect(
      OrgPlacementOverrides.safeParse(
        JSON.stringify({ org_123: { toleration: "dedicated=pool:NoSchedule" } })
      ).success
    ).toBe(false);
  });

  it("should reject a node selector key or value Kubernetes would reject", () => {
    for (const invalid of [
      { org_123: { nodeSelector: { "bad key": "a" } } },
      { org_123: { nodeSelector: { pool: "bad value" } } },
      { org_123: { nodeSelector: { "a/b/c": "a" } } },
      { org_123: { nodeSelector: { pool: "v".repeat(64) } } },
    ]) {
      expect(OrgPlacementOverrides.safeParse(JSON.stringify(invalid)).success).toBe(false);
    }
  });

  it("should reject an invalid toleration inside an override", () => {
    expect(
      OrgPlacementOverrides.safeParse(
        JSON.stringify({ org_123: { tolerations: "dedicated=pool:Nope" } })
      ).success
    ).toBe(false);
  });
});
