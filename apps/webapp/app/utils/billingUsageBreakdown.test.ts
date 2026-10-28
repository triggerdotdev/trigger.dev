import { describe, expect, it } from "vitest";
import {
  addGrouping,
  buildUsageTree,
  dropGrouping,
  monthlyUsageLeaves,
  moveGrouping,
  parseGroupings,
  projectUsageLeaves,
  removeGrouping,
  restoreGrouping,
  sumUsage,
  UNSPLIT_VALUE,
  USAGE_DIMENSIONS,
  usageProjects,
  DEFAULT_USAGE_GROUPINGS,
  type MonthlyUsageLine,
  type UsageDimension,
  usageDue,
} from "./billingUsageBreakdown";

function line(overrides: Partial<MonthlyUsageLine> = {}): MonthlyUsageLine {
  return {
    usageType: "compute",
    machinePreset: "small-1x",
    region: "us-east-1",
    environmentType: "production",
    quantity: 1000,
    unitPrice: 3.375e-6,
    total: 3.375,
    ...overrides,
  };
}

describe("monthlyUsageLeaves", () => {
  it("puts quantity on compute time or runs by usage type", () => {
    const leaves = monthlyUsageLeaves([
      line(),
      line({ usageType: "runs", quantity: 40, unitPrice: 0.0025, total: 0.1 }),
    ]);

    expect(leaves.map(({ computeMs, runs, cost }) => ({ computeMs, runs, cost }))).toEqual([
      { computeMs: 1000, runs: 0, cost: 3.375 },
      { computeMs: 0, runs: 40, cost: 0.1 },
    ]);
    expect(leaves[0].dimensions).toEqual({
      project: null,
      usageType: "compute",
      machine: "small-1x",
      environment: "production",
      region: "us-east-1",
    });
  });
});

describe("projectUsageLeaves", () => {
  it("keeps each line as one leaf with compute time, runs and no cost", () => {
    const leaves = projectUsageLeaves([
      {
        projectId: "proj_1",
        machinePreset: "micro",
        region: "eu-central-1",
        environmentType: "staging",
        computeMs: 500,
        runs: 7,
      },
    ]);

    expect(leaves).toHaveLength(1);
    expect(sumUsage(leaves)).toEqual({ cost: 0, computeMs: 500, runs: 7 });
    expect(leaves[0].dimensions.project).toBe("proj_1");
    expect(leaves[0].usageType).toBeNull();
  });
});

describe("buildUsageTree", () => {
  const leaves = monthlyUsageLeaves([
    line({ machinePreset: "small-1x", total: 10, quantity: 100 }),
    line({ machinePreset: "small-1x", environmentType: "staging", total: 2, quantity: 20 }),
    line({ machinePreset: "medium-1x", total: 30, quantity: 50, unitPrice: 0.0085 }),
    line({
      usageType: "runs",
      machinePreset: "small-1x",
      total: 1,
      quantity: 400,
      unitPrice: 0.0025,
    }),
  ]);

  it("nests the groupings in order and sorts each level by the sort key", () => {
    const tree = buildUsageTree(leaves, ["usageType", "machine"], "cost");

    expect(tree.map((node) => [node.value, node.cost])).toEqual([
      ["compute", 42],
      ["runs", 1],
    ]);
    expect(tree[0].children.map((node) => [node.value, node.cost])).toEqual([
      ["medium-1x", 30],
      ["small-1x", 12],
    ]);
    expect(tree[0].children[1].id).toBe("/usageType:compute/machine:small-1x");
  });

  it("keeps a rate only where every line under the node shares it", () => {
    const tree = buildUsageTree(leaves, ["usageType", "machine"], "cost");

    expect(tree[0].unitPrice).toBeNull();
    expect(tree[0].children[1].unitPrice).toBe(3.375e-6);
    expect(tree[1].unitPrice).toBe(0.0025);
  });

  it("drops the usage type and rate on a node that mixes compute and runs", () => {
    const tree = buildUsageTree(leaves, ["machine"], "cost");
    const small = tree.find((node) => node.value === "small-1x");

    expect(small?.usageType).toBeNull();
    expect(small?.unitPrice).toBeNull();
    expect(small?.computeMs).toBe(120);
    expect(small?.runs).toBe(400);
  });

  it("skips a grouping that every line leaves empty, as months before the v2 metrics do", () => {
    const older = monthlyUsageLeaves([
      line({ region: null, environmentType: null }),
      line({ machinePreset: "micro", region: null, environmentType: null }),
    ]);

    const tree = buildUsageTree(older, ["region", "machine", "environment"], "cost");

    expect(tree.map((node) => node.dimension)).toEqual(["machine", "machine"]);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });

  it("puts lines without a value under an unsplit bucket when others have one", () => {
    const tree = buildUsageTree(
      monthlyUsageLeaves([line(), line({ usageType: "runs", machinePreset: null, total: 1 })]),
      ["machine"],
      "cost"
    );

    expect(tree.map((node) => node.value)).toEqual(["small-1x", UNSPLIT_VALUE]);
  });

  it("keeps an all-empty last grouping as one unsplit row instead of dropping the lines", () => {
    const tree = buildUsageTree(
      monthlyUsageLeaves([line({ machinePreset: null }), line({ machinePreset: null })]),
      ["machine"],
      "cost"
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].value).toBe(UNSPLIT_VALUE);
    expect(tree[0].computeMs).toBe(2000);
  });

  it("handles v1 lines: no region or environment, and runs without a machine", () => {
    const v1 = monthlyUsageLeaves([
      line({ region: null, environmentType: null, total: 10 }),
      line({ machinePreset: "micro", region: null, environmentType: null, total: 5 }),
      line({
        usageType: "runs",
        machinePreset: null,
        region: null,
        environmentType: null,
        unitPrice: 0.0025,
        total: 1,
      }),
    ]);

    const byType = buildUsageTree(v1, ["usageType", "machine", "environment"], "cost");
    expect(byType.map((node) => [node.value, node.children.map((child) => child.value)])).toEqual([
      ["compute", ["small-1x", "micro"]],
      ["runs", []],
    ]);

    const byMachine = buildUsageTree(v1, ["machine", "region"], "cost");
    expect(byMachine.map((node) => node.value)).toEqual(["small-1x", "micro", UNSPLIT_VALUE]);
  });

  it("returns no rows without groupings", () => {
    expect(buildUsageTree(leaves, [], "cost")).toEqual([]);
  });
});

describe("parseGroupings", () => {
  it("falls back to the defaults without a value", () => {
    expect(parseGroupings(undefined, USAGE_DIMENSIONS, DEFAULT_USAGE_GROUPINGS)).toEqual(
      DEFAULT_USAGE_GROUPINGS
    );
  });

  it("keeps the order from the URL and drops unknown or repeated values", () => {
    expect(
      parseGroupings("region,bogus,machine,region", USAGE_DIMENSIONS, DEFAULT_USAGE_GROUPINGS)
    ).toEqual(["region", "machine"]);
  });

  it("drops a grouping the tab does not offer", () => {
    expect(parseGroupings("project", USAGE_DIMENSIONS, DEFAULT_USAGE_GROUPINGS)).toEqual(
      DEFAULT_USAGE_GROUPINGS
    );
  });

  it("filters the defaults to the groupings on offer", () => {
    expect(parseGroupings(undefined, ["machine", "region"], ["project", "machine"])).toEqual([
      "machine",
    ]);
    expect(parseGroupings(undefined, ["region"], ["project"])).toEqual(["region"]);
  });

  it("round-trips a comma-joined order", () => {
    const groupings = parseGroupings(
      ["environment", "usageType"].join(","),
      USAGE_DIMENSIONS,
      DEFAULT_USAGE_GROUPINGS
    );
    expect(groupings).toEqual(["environment", "usageType"]);
  });
});

describe("grouping edits", () => {
  const groupings: UsageDimension[] = ["usageType", "machine", "environment"];

  it("moves a grouping one place and ignores moves past either end", () => {
    expect(moveGrouping(groupings, "machine", -1)).toEqual(["machine", "usageType", "environment"]);
    expect(moveGrouping(groupings, "usageType", -1)).toBe(groupings);
    expect(moveGrouping(groupings, "environment", 1)).toBe(groupings);
  });

  it("removes a grouping but always keeps one", () => {
    expect(removeGrouping(groupings, "machine")).toEqual(["usageType", "environment"]);
    expect(removeGrouping(["region"], "region")).toEqual(["region"]);
  });

  it("drops a dragged grouping into the target's place", () => {
    expect(dropGrouping(groupings, "usageType", "environment")).toEqual([
      "machine",
      "environment",
      "usageType",
    ]);
    expect(dropGrouping(groupings, "environment", "usageType")).toEqual([
      "environment",
      "usageType",
      "machine",
    ]);
    expect(dropGrouping(groupings, "machine", "machine")).toBe(groupings);
    expect(dropGrouping(groupings, "region", "machine")).toBe(groupings);
  });

  it("puts a hidden grouping back where it was after an edit made without it", () => {
    expect(
      restoreGrouping(["project", "machine", "region"], ["region", "machine"], "project")
    ).toEqual(["project", "region", "machine"]);
    expect(restoreGrouping(["machine", "project"], ["machine"], "project")).toEqual([
      "machine",
      "project",
    ]);
    expect(restoreGrouping(["machine"], ["region"], "project")).toEqual(["region"]);
  });

  it("adds a grouping at the end once", () => {
    expect(addGrouping(groupings, "region")).toEqual([...groupings, "region"]);
    expect(addGrouping(groupings, "machine")).toBe(groupings);
  });
});

describe("usageProjects", () => {
  const named = { id: "proj_a", name: "api", slug: "api", externalRef: "proj_a", deleted: false };

  it("keeps projects whose names could not be looked up, labelled by id", () => {
    expect(usageProjects({ projects: [named], projectIds: ["proj_a", "proj_b"] })).toEqual([
      named,
      { id: "proj_b", name: "proj_b", slug: "", externalRef: "proj_b", deleted: false },
    ]);
  });

  it("lists every project by id when the lookup returned nothing", () => {
    expect(usageProjects({ projects: [], projectIds: ["proj_a"] }).map((p) => p.name)).toEqual([
      "proj_a",
    ]);
  });
});

describe("usageDue", () => {
  it("bills the usage the credits didn't pay, even when more credit was available", () => {
    // cat-20261020: $8.15 of usage, $0.80 paid by the Free credit, $23.72 of plan credit available.
    expect(
      usageDue({ total: 815.2, creditsApplied: 80, creditsForUsage: 2372 } as never)
    ).toBeCloseTo(735.2);
  });

  it("never goes below zero", () => {
    expect(usageDue({ total: 100, creditsApplied: 120 })).toBe(0);
  });
});
