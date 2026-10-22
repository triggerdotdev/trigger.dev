import { describe, it, expect } from "vitest";
import {
  regionForQueue,
  backingForQueue,
  containerQueueForComputeQueue,
  type WorkerGroupRegionRow,
} from "~/v3/workerRegions.server";

const groups: WorkerGroupRegionRow[] = [
  {
    masterQueue: "us-east-1",
    region: "us-east-1",
    workloadType: "CONTAINER",
    hidden: false,
    enableFastPath: false,
    type: "MANAGED",
    projectId: null,
  },
  {
    masterQueue: "us-east-1-next",
    region: "us-east-1",
    workloadType: "MICROVM",
    hidden: false,
    enableFastPath: true,
    type: "MANAGED",
    projectId: null,
  },
  {
    masterQueue: "eu-central-1",
    region: "eu-central-1",
    workloadType: "CONTAINER",
    hidden: false,
    enableFastPath: false,
    type: "MANAGED",
    projectId: null,
  },
];

describe("regionForQueue", () => {
  it("maps a backing queue to its region", () => {
    expect(regionForQueue("us-east-1-next", groups)).toBe("us-east-1");
  });
  it("maps a container queue to its own region", () => {
    expect(regionForQueue("us-east-1", groups)).toBe("us-east-1");
  });
  it("passes an unknown queue through unchanged", () => {
    expect(regionForQueue("mystery", groups)).toBe("mystery");
  });
  it("passes through when a group has no region set", () => {
    expect(
      regionForQueue("x", [
        {
          masterQueue: "x",
          region: null,
          workloadType: "CONTAINER",
          hidden: false,
          enableFastPath: false,
          type: "MANAGED",
          projectId: null,
        },
      ])
    ).toBe("x");
  });
});

describe("backingForQueue", () => {
  it("finds the MICROVM backing for a region with one", () => {
    expect(backingForQueue("us-east-1", groups)).toEqual({
      workerQueue: "us-east-1-next",
      enableFastPath: true,
    });
  });
  it("returns undefined for a region with no compute backing (EU)", () => {
    expect(backingForQueue("eu-central-1", groups)).toBeUndefined();
  });
  it("returns undefined when the queue's group has no region", () => {
    expect(
      backingForQueue("x", [
        {
          masterQueue: "x",
          region: null,
          workloadType: "CONTAINER",
          hidden: false,
          enableFastPath: false,
          type: "MANAGED",
          projectId: null,
        },
      ])
    ).toBeUndefined();
  });
  it("ignores hidden MICROVM groups", () => {
    const g: WorkerGroupRegionRow[] = [
      {
        masterQueue: "us-east-1",
        region: "us-east-1",
        workloadType: "CONTAINER",
        hidden: false,
        enableFastPath: false,
        type: "MANAGED",
        projectId: null,
      },
      {
        masterQueue: "us-east-1-next",
        region: "us-east-1",
        workloadType: "MICROVM",
        hidden: true,
        enableFastPath: true,
        type: "MANAGED",
        projectId: null,
      },
    ];
    expect(backingForQueue("us-east-1", g)).toBeUndefined();
  });
});

describe("containerQueueForComputeQueue", () => {
  it("maps a legacy compute queue to its region's container queue", () => {
    expect(containerQueueForComputeQueue("us-east-1-next", groups)).toBe("us-east-1");
  });
  it("keeps the scheduled class of a legacy queue", () => {
    expect(containerQueueForComputeQueue("us-east-1-next:scheduled", groups)).toBe(
      "us-east-1:scheduled"
    );
  });
  it("returns undefined for a container queue", () => {
    expect(containerQueueForComputeQueue("us-east-1", groups)).toBeUndefined();
  });
  it("returns undefined for an unknown queue", () => {
    expect(containerQueueForComputeQueue("mystery", groups)).toBeUndefined();
  });
  it("returns undefined when the region has no container group", () => {
    expect(
      containerQueueForComputeQueue("ap-1-next", [
        {
          masterQueue: "ap-1-next",
          region: "ap-1",
          workloadType: "MICROVM",
          hidden: false,
          enableFastPath: false,
          type: "MANAGED",
          projectId: null,
        },
      ])
    ).toBeUndefined();
  });
  it("prefers the container group named after the region", () => {
    const g: WorkerGroupRegionRow[] = [
      {
        masterQueue: "private-us-east-1",
        region: "us-east-1",
        workloadType: "CONTAINER",
        hidden: false,
        enableFastPath: false,
        type: "MANAGED",
        projectId: null,
      },
      ...groups,
    ];
    expect(containerQueueForComputeQueue("us-east-1-next", g)).toBe("us-east-1");
  });
  it("moves a v2 compute queue to the stable container lane of its region", () => {
    expect(
      containerQueueForComputeQueue("us-east-1:v2:scheduled:fresh:compute:canary", groups)
    ).toBe("us-east-1:v2:scheduled:fresh:container:stable");
  });
  it("accepts a container group without a region that serves the queue's region by name", () => {
    expect(
      containerQueueForComputeQueue("eu-west-1:v2:ondemand:fresh:compute:stable", [
        {
          masterQueue: "eu-west-1",
          region: null,
          workloadType: "CONTAINER",
          hidden: false,
          enableFastPath: false,
          type: "MANAGED",
          projectId: null,
        },
      ])
    ).toBe("eu-west-1:v2:ondemand:fresh:container:stable");
  });
  it("returns undefined for a v2 compute queue in a region with no container group", () => {
    expect(
      containerQueueForComputeQueue("ap-1:v2:ondemand:fresh:compute:stable", groups)
    ).toBeUndefined();
  });
  it("moves a v2 queue that any runtime can take to containers", () => {
    expect(containerQueueForComputeQueue("us-east-1:v2:ondemand:fresh:any:stable", groups)).toBe(
      "us-east-1:v2:ondemand:fresh:container:stable"
    );
  });
  it("returns undefined for a v2 container queue", () => {
    expect(
      containerQueueForComputeQueue("us-east-1:v2:ondemand:fresh:container:stable", groups)
    ).toBeUndefined();
  });
});

describe("containerQueueForComputeQueue with project-scoped groups", () => {
  const scoped = (
    type: "MANAGED" | "UNMANAGED",
    projectId: string | null
  ): WorkerGroupRegionRow => ({
    masterQueue: "proj_1-us-east-1",
    region: "us-east-1",
    workloadType: "CONTAINER",
    hidden: false,
    enableFastPath: false,
    type,
    projectId,
  });
  const microvm: WorkerGroupRegionRow = {
    masterQueue: "us-east-1-next",
    region: "us-east-1",
    workloadType: "MICROVM",
    hidden: false,
    enableFastPath: true,
    type: "MANAGED",
    projectId: null,
  };

  for (const [name, group] of [
    ["an UNMANAGED group", scoped("UNMANAGED", "proj_1")],
    ["another project's MANAGED group", scoped("MANAGED", "proj_1")],
  ] as const) {
    it(`never picks ${name} for a legacy queue`, () => {
      expect(containerQueueForComputeQueue("us-east-1-next", [microvm, group])).toBeUndefined();
    });
    it(`never picks ${name} for a v2 queue`, () => {
      expect(
        containerQueueForComputeQueue("us-east-1:v2:ondemand:fresh:compute:stable", [
          microvm,
          group,
        ])
      ).toBeUndefined();
    });
    it(`never picks ${name} that has no region for a v2 queue`, () => {
      expect(
        containerQueueForComputeQueue("proj_1-us-east-1:v2:ondemand:fresh:compute:stable", [
          { ...group, region: null },
        ])
      ).toBeUndefined();
    });
  }

  it("picks the shared group when a scoped one is also in the region", () => {
    const shared: WorkerGroupRegionRow = { ...scoped("MANAGED", null), masterQueue: "us-east-1" };
    expect(
      containerQueueForComputeQueue("us-east-1-next", [
        scoped("UNMANAGED", "proj_1"),
        microvm,
        shared,
      ])
    ).toBe("us-east-1");
  });
});
