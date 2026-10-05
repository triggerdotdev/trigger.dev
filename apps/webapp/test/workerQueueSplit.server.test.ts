import { describe, expect, it } from "vitest";
import {
  matchesDisabledWorkerQueue,
  parseDisabledWorkerQueues,
} from "~/runEngine/concerns/workerQueueSplit.server";

describe("parseDisabledWorkerQueues", () => {
  it("returns an empty set for undefined or empty input", () => {
    expect(parseDisabledWorkerQueues(undefined).size).toBe(0);
    expect(parseDisabledWorkerQueues("").size).toBe(0);
    expect(parseDisabledWorkerQueues("  ,  ,").size).toBe(0);
  });

  it("splits, trims, and drops empties", () => {
    const parsed = parseDisabledWorkerQueues(" eu-central-1 , us-east-1:scheduled ,, ");
    expect([...parsed]).toEqual(["eu-central-1", "us-east-1:scheduled"]);
  });
});

describe("matchesDisabledWorkerQueue", () => {
  it("never matches when the disabled set is empty", () => {
    const empty = parseDisabledWorkerQueues(undefined);
    expect(matchesDisabledWorkerQueue("eu-central-1", empty)).toBe(false);
    expect(matchesDisabledWorkerQueue("eu-central-1:scheduled", empty)).toBe(false);
  });

  it("gates the base region and its scheduled split when the base region is listed", () => {
    const disabled = parseDisabledWorkerQueues("eu-central-1");
    expect(matchesDisabledWorkerQueue("eu-central-1", disabled)).toBe(true);
    expect(matchesDisabledWorkerQueue("eu-central-1:scheduled", disabled)).toBe(true);
  });

  it("gates opaque legacy names containing a v2 segment by their base queue", () => {
    const disabled = parseDisabledWorkerQueues("eu-central-1");
    for (const name of ["eu-central-1:v2:private", "eu-central-1:v2:ondemand:fresh:any:stable"]) {
      expect(matchesDisabledWorkerQueue(name, disabled, "legacy")).toBe(true);
      expect(matchesDisabledWorkerQueue(`${name}:scheduled`, disabled, "legacy")).toBe(true);
    }
  });

  it.each([
    "eu-central-1:v2:ondemand:fresh:any:stable",
    "eu-central-1:v2:scheduled:fresh:container:canary",
    "eu-central-1:v2:ondemand:restore:container:stable",
    "eu-central-1:v2:scheduled:restore:compute:stable",
  ])("does not gate v2 lane %s when only the base region is listed", (workerQueue) => {
    expect(
      matchesDisabledWorkerQueue(workerQueue, parseDisabledWorkerQueues("eu-central-1"), "v2")
    ).toBe(false);
  });

  it("gates only the exact v2 lane, not other classes, phases, runtimes or channels", () => {
    const lane = "eu-central-1:v2:ondemand:restore:container:stable";
    const disabled = parseDisabledWorkerQueues(lane);
    expect(matchesDisabledWorkerQueue(lane, disabled, "v2")).toBe(true);
    for (const other of [
      "eu-central-1",
      "eu-central-1:scheduled",
      "eu-central-1:v2:ondemand:fresh:container:stable",
      "eu-central-1:v2:ondemand:restore:compute:stable",
      "eu-central-1:v2:scheduled:restore:container:stable",
      "eu-central-1:v2:ondemand:restore:container:canary",
    ]) {
      expect(matchesDisabledWorkerQueue(other, disabled, "v2")).toBe(false);
    }
  });

  it("leaves other regions alone", () => {
    const disabled = parseDisabledWorkerQueues("eu-central-1");
    expect(matchesDisabledWorkerQueue("us-east-1", disabled)).toBe(false);
    expect(matchesDisabledWorkerQueue("us-east-1:scheduled", disabled)).toBe(false);
  });

  it("gates only the scheduled split when a full worker queue is listed", () => {
    const disabled = parseDisabledWorkerQueues("eu-central-1:scheduled");
    expect(matchesDisabledWorkerQueue("eu-central-1:scheduled", disabled)).toBe(true);
    expect(matchesDisabledWorkerQueue("eu-central-1", disabled)).toBe(false);
  });
});
