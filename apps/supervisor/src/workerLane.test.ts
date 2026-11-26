import { describe, expect, it } from "vitest";
import { mayWarmStart, workerLaneFor } from "./workerLane.js";

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

describe("mayWarmStart", () => {
  it("lets an ordinary run warm start", () => {
    expect(mayWarmStart(undefined)).toBe(true);
    expect(mayWarmStart({ triggerSource: "api" })).toBe(true);
  });

  // Catches: a compute-only run handed by firestarter to a long-polling container runner of the same version
  it("never warm starts a sandbox or a compute-only run", () => {
    expect(mayWarmStart({ executionMode: "SANDBOX" })).toBe(false);
    expect(mayWarmStart({ computeOnly: true })).toBe(false);
  });
});
