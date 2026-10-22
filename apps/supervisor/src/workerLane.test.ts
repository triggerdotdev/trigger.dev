import { describe, expect, it } from "vitest";
import { workerLaneFor } from "./workerLane.js";

describe("workerLaneFor", () => {
  it("follows the configured runtime on the run-crd backend", () => {
    expect(workerLaneFor("run-crd", "microvm")).toBe("microvm");
    expect(workerLaneFor("run-crd", "container")).toBe("container");
  });

  it("is always container on the pod and docker backends", () => {
    expect(workerLaneFor("kubernetes", "microvm")).toBe("container");
    expect(workerLaneFor("docker", "microvm")).toBe("container");
  });
});
