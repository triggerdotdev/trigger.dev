import { describe, it, expect } from "vitest";
import { TaskRunProcessPool } from "./taskRunProcessPool.js";

describe("TaskRunProcessPool", () => {
  it("getAllPids returns empty array when pool is empty", () => {
    const pool = new TaskRunProcessPool({
      env: {},
      cwd: "/tmp",
      enableProcessReuse: false,
    });

    expect(pool.getAllPids()).toEqual([]);
  });

  it("getAllPids returns no undefined values", () => {
    const pool = new TaskRunProcessPool({
      env: {},
      cwd: "/tmp",
      enableProcessReuse: false,
    });

    const pids = pool.getAllPids();
    expect(pids.every((pid) => typeof pid === "number")).toBe(true);
  });
});