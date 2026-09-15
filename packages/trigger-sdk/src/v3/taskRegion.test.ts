import { resourceCatalog } from "@trigger.dev/core/v3";
import { StandardResourceCatalog } from "@trigger.dev/core/v3/workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { task as scheduledTask } from "./schedules/index.js";
import { schemaTask, task } from "./tasks.js";

describe("task-level region option", () => {
  beforeEach(() => {
    resourceCatalog.disable();
    resourceCatalog.setGlobalResourceCatalog(new StandardResourceCatalog());
    resourceCatalog.setCurrentFileContext("regions.ts", "regions.ts");
  });

  afterEach(() => {
    resourceCatalog.clearCurrentFileContext();
    resourceCatalog.disable();
  });

  it("normalizes a single region into a one-element list", () => {
    task({ id: "single", region: "eu-central-1", run: async () => {} });

    expect(resourceCatalog.getTaskManifest("single")?.regions).toEqual(["eu-central-1"]);
  });

  it("keeps a list in order and de-duplicates it", () => {
    task({
      id: "multi",
      region: ["eu-central-1", "us-east-1", "eu-central-1"],
      run: async () => {},
    });

    expect(resourceCatalog.getTaskManifest("multi")?.regions).toEqual([
      "eu-central-1",
      "us-east-1",
    ]);
  });

  it("omits regions when the option is not set", () => {
    task({ id: "none", run: async () => {} });

    expect(resourceCatalog.getTaskManifest("none")?.regions).toBeUndefined();
  });

  it("treats an empty or blank list as no constraint", () => {
    task({ id: "empty", region: [], run: async () => {} });
    task({ id: "blank", region: [" ", ""], run: async () => {} });

    expect(resourceCatalog.getTaskManifest("empty")?.regions).toBeUndefined();
    expect(resourceCatalog.getTaskManifest("blank")?.regions).toBeUndefined();
  });

  it("trims whitespace around region names", () => {
    task({ id: "trim", region: " us-east-1 ", run: async () => {} });

    expect(resourceCatalog.getTaskManifest("trim")?.regions).toEqual(["us-east-1"]);
  });

  it("applies to schema tasks and scheduled tasks", () => {
    schemaTask({
      id: "schema",
      schema: z.object({ n: z.number() }),
      region: "us-east-1",
      run: async () => {},
    });
    scheduledTask({
      id: "scheduled",
      cron: "0 9 * * *",
      region: ["us-east-1", "eu-central-1"],
      run: async () => {},
    });

    expect(resourceCatalog.getTaskManifest("schema")?.regions).toEqual(["us-east-1"]);
    expect(resourceCatalog.getTaskManifest("scheduled")?.regions).toEqual([
      "us-east-1",
      "eu-central-1",
    ]);
  });
});
