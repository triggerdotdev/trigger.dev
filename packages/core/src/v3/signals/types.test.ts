import { describe, expect, it } from "vitest";
import { signalNameError, signalPayloadError, skewProtectionThresholdForTask } from "./types.js";

describe("skewProtectionThresholdForTask", () => {
  // Catches: a task threshold lower than the environment's winning (the floor is the higher).
  it("takes the higher of the environment's and the task's own", () => {
    const payload = {
      environment: "20261119.2",
      tasks: { a: "20261119.10", b: "20261119.1" },
      midTurnTasks: ["a", "b", "c"],
    };
    expect(skewProtectionThresholdForTask(payload, "a")).toBe("20261119.10");
    expect(skewProtectionThresholdForTask(payload, "b")).toBe("20261119.2");
    expect(skewProtectionThresholdForTask(payload, "c")).toBe("20261119.2");
    const own = { tasks: { a: "1.2" }, midTurnTasks: ["a", "b"] };
    expect(skewProtectionThresholdForTask(own, "a")).toBe("1.2");
    expect(skewProtectionThresholdForTask(own, "b")).toBeUndefined();
  });

  // Catches: a turn moving when its task's current deployment can't continue it (an older SDK, or
  // the task isn't an agent there).
  it("is undefined for a task not in midTurnTasks, and for an empty or malformed payload", () => {
    expect(
      skewProtectionThresholdForTask({ environment: "1.2", midTurnTasks: ["b"] }, "a")
    ).toBeUndefined();
    expect(skewProtectionThresholdForTask({ environment: "1.2" }, "a")).toBeUndefined();
    expect(
      skewProtectionThresholdForTask({ environment: "1.2", midTurnTasks: "a" }, "a")
    ).toBeUndefined();
    expect(skewProtectionThresholdForTask({}, "a")).toBeUndefined();
    expect(skewProtectionThresholdForTask(null, "a")).toBeUndefined();
    expect(skewProtectionThresholdForTask({ environment: 3, tasks: "x" }, "a")).toBeUndefined();
    expect(
      skewProtectionThresholdForTask({ tasks: { ["__proto__"]: 1 } }, "__proto__")
    ).toBeUndefined();
  });
});

describe("signalNameError", () => {
  // Catches: the SDK and the server disagreeing on which names a send may use.
  it("refuses bad names, and reserved names unless allowed", () => {
    expect(signalNameError("deploy.v2:ready")).toBeUndefined();
    expect(signalNameError("")).toMatch(/isn't a signal name/);
    expect(signalNameError(".starts-with-dot")).toMatch(/isn't a signal name/);
    expect(signalNameError("a".repeat(129))).toMatch(/isn't a signal name/);
    expect(signalNameError("trigger.anything")).toMatch(/reserved/);
    expect(signalNameError("trigger.anything", { allowReserved: true })).toBeUndefined();
  });
});

describe("signalPayloadError", () => {
  // Catches: a payload over the limit reaching the stream.
  it("measures the payload as JSON bytes", () => {
    expect(signalPayloadError({ a: "x".repeat(1000) })).toBeUndefined();
    expect(signalPayloadError("é".repeat(600))).toMatch(/at most 1024 bytes as JSON \(got 1202\)/);
    expect(signalPayloadError(undefined)).toBeUndefined();
    expect(signalPayloadError("x".repeat(40), 32)).toMatch(/at most 32 bytes/);
  });
});
