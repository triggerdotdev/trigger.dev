import { describe, expect, it } from "vitest";
import { stampWorkerAnnotations } from "./runAttemptSystem.js";

const triggerAnnotations = {
  triggerSource: "sdk",
  triggerAction: "trigger",
  rootTriggerSource: "sdk",
  taskKind: "STANDARD",
};

describe("stampWorkerAnnotations", () => {
  it("returns undefined when there is nothing to stamp and nothing to clear", () => {
    expect(stampWorkerAnnotations(triggerAnnotations, {})).toBeUndefined();
    expect(stampWorkerAnnotations(null, {})).toBeUndefined();
  });

  it("clears a previous stamp when the new attempt is unstamped", () => {
    const previous = { ...triggerAnnotations, workerCell: "cell-a", workerLane: "microvm" };
    expect(stampWorkerAnnotations(previous, {})).toEqual(triggerAnnotations);
  });

  it("keeps every existing key and adds the stamp", () => {
    expect(
      stampWorkerAnnotations(triggerAnnotations, { workerCell: "cell-a", workerLane: "microvm" })
    ).toEqual({ ...triggerAnnotations, workerCell: "cell-a", workerLane: "microvm" });
  });

  it("replaces the previous stamp as a unit and nothing else", () => {
    const previous = { ...triggerAnnotations, workerCell: "cell-a", workerLane: "microvm" };
    expect(
      stampWorkerAnnotations(previous, { workerCell: "cell-b", workerLane: "container" })
    ).toEqual({ ...triggerAnnotations, workerCell: "cell-b", workerLane: "container" });
    expect(stampWorkerAnnotations(previous, { workerLane: "container" })).toEqual({
      ...triggerAnnotations,
      workerLane: "container",
    });
  });

  it("starts from an empty object when the run has no usable annotations", () => {
    expect(stampWorkerAnnotations(null, { workerCell: "cell-a" })).toEqual({
      workerCell: "cell-a",
    });
    expect(stampWorkerAnnotations("oops", { workerLane: "container" })).toEqual({
      workerLane: "container",
    });
    expect(stampWorkerAnnotations([1, 2], { workerCell: "cell-a" })).toEqual({
      workerCell: "cell-a",
    });
  });
});
