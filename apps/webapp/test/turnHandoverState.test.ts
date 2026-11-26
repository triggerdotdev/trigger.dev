import {
  sameSkewProtectionThresholdSignal,
  skewProtectionThresholdSignalPayload,
  taskContinuesTurns,
  turnContinuationVersion,
} from "~/services/realtime/turnHandoverState";
import type { SkewProtectionThresholds } from "~/v3/services/skewProtectionThresholds.server";

const threshold = (version: string) => ({ version, setAt: "2026-11-23T00:00:00Z" });

function thresholds(
  environment: string | undefined,
  tasks: Record<string, string> = {}
): SkewProtectionThresholds {
  return {
    environment: environment ? threshold(environment) : undefined,
    tasks: new Map(Object.entries(tasks).map(([task, version]) => [task, threshold(version)])),
  };
}

describe("skewProtectionThresholdSignalPayload", () => {
  it("carries the thresholds' versions as stored", () => {
    expect(skewProtectionThresholdSignalPayload(thresholds("20261123.2"), ["a"])).toEqual({
      environment: "20261123.2",
      midTurnTasks: ["a"],
    });
    expect(
      skewProtectionThresholdSignalPayload(thresholds("20261123.2", { a: "20261123.1" }), [
        "b",
        "a",
      ])
    ).toEqual({ environment: "20261123.2", tasks: { a: "20261123.1" }, midTurnTasks: ["a", "b"] });
  });

  // Catches: a task-only threshold listing every agent, which the platform payload budget doesn't cover.
  it("lists only tasks with their own threshold when the environment has none", () => {
    expect(
      skewProtectionThresholdSignalPayload(thresholds(undefined, { a: "1" }), ["a", "b"])
    ).toEqual({ tasks: { a: "1" }, midTurnTasks: ["a"] });
  });

  // Catches: turns handed to a current deployment whose task can't continue them.
  it("lists no task when none of the current deployment's tasks can continue a turn", () => {
    expect(skewProtectionThresholdSignalPayload(thresholds("20261123.2"), [])).toEqual({
      environment: "20261123.2",
    });
  });

  // Catches: a promote with no thresholds sending a signal nobody needs.
  it("is empty with no thresholds, whatever the deployment", () => {
    expect(skewProtectionThresholdSignalPayload(thresholds(undefined), ["a"])).toEqual({});
  });
});

describe("sameSkewProtectionThresholdSignal", () => {
  // Catches: a repeated set sending again, or a missing latest signal not counting as empty.
  it("ignores task order and reads a missing signal as empty", () => {
    expect(
      sameSkewProtectionThresholdSignal(
        { tasks: { a: "1", b: "2" } },
        { tasks: { b: "2", a: "1" } }
      )
    ).toBe(true);
    expect(sameSkewProtectionThresholdSignal({}, undefined)).toBe(true);
    expect(sameSkewProtectionThresholdSignal({ environment: "1" }, {})).toBe(false);
    expect(
      sameSkewProtectionThresholdSignal(
        { environment: "1" },
        { environment: "1", midTurnTasks: ["a"] }
      )
    ).toBe(false);
    expect(
      sameSkewProtectionThresholdSignal({ midTurnTasks: ["a", "b"] }, { midTurnTasks: ["b", "a"] })
    ).toBe(true);
  });
});

describe("taskContinuesTurns", () => {
  // Catches: a task on an SDK without handover (no `turnHandover` in its agent config) counted as
  // able to continue a turn, which would answer the turn again from its first step.
  it("needs turnHandover: true in the task's agent config", () => {
    expect(taskContinuesTurns({ type: "ai-sdk-chat", turnHandover: true })).toBe(true);
    expect(taskContinuesTurns({ type: "ai-sdk-chat", versionSkew: "follow" })).toBe(false);
    expect(taskContinuesTurns({ type: "ai-sdk-chat", turnHandover: "true" })).toBe(false);
    expect(taskContinuesTurns(null)).toBe(false);
    expect(taskContinuesTurns(undefined)).toBe(false);
  });
});

describe("the version a handed-over turn continues on", () => {
  it("is the current deployment when its task can continue a turn", () => {
    expect(
      turnContinuationVersion(
        { version: "20261123.11", taskConfig: { type: "ai-sdk-chat", turnHandover: true } },
        "20261123.10"
      )
    ).toBe("20261123.11");
  });

  // Catches: a promote to an older SDK just before the handover starting the continuation on it,
  // which would answer the turn again from its first step (loop 12).
  it("is the handing-over run's version when the current task can't", () => {
    expect(
      turnContinuationVersion(
        { version: "20261123.12", taskConfig: { type: "ai-sdk-chat" } },
        "20261123.10"
      )
    ).toBe("20261123.10");
    expect(turnContinuationVersion(undefined, "20261123.10")).toBe("20261123.10");
  });
});
