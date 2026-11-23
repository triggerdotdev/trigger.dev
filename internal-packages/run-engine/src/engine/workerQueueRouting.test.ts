import { describe, expect, it } from "vitest";
import { legacyToV2WorkerQueues, workerQueueForPublish } from "./workerQueueRouting.js";

const production = { id: "env_1", type: "PRODUCTION" } as const;
const legacyOnV2 = legacyToV2WorkerQueues(["us-east-1"]);

describe("workerQueueForPublish", () => {
  it.each([
    ["us-east-1", undefined, "us-east-1:v2:ondemand:fresh:container:stable"],
    ["us-east-1:scheduled", undefined, "us-east-1:v2:scheduled:fresh:container:stable"],
    ["us-east-1", "KUBERNETES", "us-east-1:v2:ondemand:restore:container:stable"],
    ["us-east-1:scheduled", "KUBERNETES", "us-east-1:v2:scheduled:restore:container:stable"],
    ["us-east-1", "COMPUTE", "us-east-1:v2:ondemand:restore:compute:stable"],
  ] as const)(
    "moves legacy %s (checkpoint %s) onto %s",
    (workerQueue, checkpointType, expected) => {
      const checkpoint = checkpointType ? { type: checkpointType } : undefined;
      expect(workerQueueForPublish({ workerQueue }, production, checkpoint, legacyOnV2)).toBe(
        expected
      );
    }
  );

  it.each(["eu-central-1", "us-nyc-3", "cmoarra1s01t5of0h54v1a7oq-us-east-1", "us-east-1-next"])(
    "keeps unlisted legacy queue %s",
    (workerQueue) => {
      expect(workerQueueForPublish({ workerQueue }, production, undefined, legacyOnV2)).toBe(
        workerQueue
      );
      expect(
        workerQueueForPublish({ workerQueue }, production, { type: "KUBERNETES" }, legacyOnV2)
      ).toBe(workerQueue);
    }
  );

  it("keeps v2 queues", () => {
    expect(
      workerQueueForPublish(
        { workerQueue: "us-east-1:v2:ondemand:fresh:container:canary" },
        production,
        { type: "KUBERNETES" },
        legacyOnV2
      )
    ).toBe("us-east-1:v2:ondemand:restore:container:canary");
  });

  it("keeps legacy queues without a mapping", () => {
    expect(workerQueueForPublish({ workerQueue: "us-east-1" }, production)).toBe("us-east-1");
  });

  it("uses the environment id in development", () => {
    expect(
      workerQueueForPublish(
        { workerQueue: "us-east-1" },
        { id: "env_dev", type: "DEVELOPMENT" },
        undefined,
        legacyOnV2
      )
    ).toBe("env_dev");
  });
});
