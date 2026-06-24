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
