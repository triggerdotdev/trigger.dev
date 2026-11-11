import { describe, expect, it, vi } from "vitest";
import type { SessionOutTail } from "~/services/realtime/s2realtimeStreams.server";
import {
  areSessionStreamsIdle,
  basePayloadHasMessage,
  isVersionBelowSessionVersionFloor,
  type LiveRunFloorChecks,
  NEVER_MESSAGED_IDLE_MS,
  SESSION_IN_WAITPOINT_CHECK_MAX_IDS,
  SESSION_IN_WAITPOINT_CHECK_TIMEOUT_MS,
  sessionVersionFloorFor,
  shouldSupersedeLiveRun,
  TURN_COMPLETE_GRACE_MS,
} from "~/services/realtime/sessionVersionFloor.server";

const ENV_ID = "cmenv00000000000000000001";
const NOW = 1_800_000_000_000;

function turnComplete(ageMs: number, inConsumedSeq: number | undefined): SessionOutTail {
  return { kind: "record", control: "turn-complete", timestamp: NOW - ageMs, inConsumedSeq };
}

function environment(featureFlags: unknown, type = "PRODUCTION") {
  return { id: ENV_ID, type, organization: { featureFlags } };
}

describe("sessionVersionFloorFor", () => {
  it("returns undefined when the org has no floor for the environment", () => {
    expect(sessionVersionFloorFor(environment(null))).toBeUndefined();
    expect(sessionVersionFloorFor(environment({}))).toBeUndefined();
    expect(
      sessionVersionFloorFor(
        environment({ sessionVersionFloor: { otherEnv: { minVersion: "20261108.1" } } })
      )
    ).toBeUndefined();
  });

  it("ignores an invalid or empty entry instead of throwing", () => {
    for (const entry of [{ minVersion: 5 }, { minVersion: "" }, {}, "20261108.2"]) {
      expect(
        sessionVersionFloorFor(environment({ sessionVersionFloor: { [ENV_ID]: entry } }))
      ).toBeUndefined();
    }
    expect(sessionVersionFloorFor(environment({ sessionVersionFloor: "x" }))).toBeUndefined();
  });

  it("reads the environment's minVersion", () => {
    expect(
      sessionVersionFloorFor(
        environment({ sessionVersionFloor: { [ENV_ID]: { minVersion: "20261108.2" } } })
      )
    ).toEqual({ minVersion: "20261108.2" });
  });

  it("never applies to a development environment", () => {
    expect(
      sessionVersionFloorFor(
        environment(
          { sessionVersionFloor: { [ENV_ID]: { minVersion: "20261108.2" } } },
          "DEVELOPMENT"
        )
      )
    ).toBeUndefined();
  });
});

describe("isVersionBelowSessionVersionFloor", () => {
  it("compares the deploy number numerically, not as text", () => {
    expect(isVersionBelowSessionVersionFloor("20261108.9", { minVersion: "20261108.10" })).toBe(
      true
    );
    expect(isVersionBelowSessionVersionFloor("20261108.10", { minVersion: "20261108.9" })).toBe(
      false
    );
  });

  it("treats the floor version itself and anything newer as not below", () => {
    const floor = { minVersion: "20261108.2" };
    expect(isVersionBelowSessionVersionFloor("20261108.2", floor)).toBe(false);
    expect(isVersionBelowSessionVersionFloor("20261109.1", floor)).toBe(false);
    expect(isVersionBelowSessionVersionFloor("20261107.30", floor)).toBe(true);
  });
});

describe("shouldSupersedeLiveRun", () => {
  const floor = { minVersion: "20261108.2" };
  const oldRun = {
    id: "run_old",
    taskVersion: "20261101.1",
    createdAt: new Date(NOW - 600_000),
    startedWithMessage: false,
  };
  const notRead = () => Promise.reject(new Error("not read"));

  function checks(
    options: {
      current?: string;
      outTail?: SessionOutTail | Error;
      streams?: false;
      waitingRunIds?: string[];
      waitpointList?: Promise<string[]>;
      waitpointIds?: string[];
      blockingRead?: Promise<boolean>;
    } = {}
  ) {
    const reads: string[] = [];
    const outTail = options.outTail ?? turnComplete(TURN_COMPLETE_GRACE_MS + 1, 0);
    const value: LiveRunFloorChecks = {
      currentDeploymentVersion: async () => {
        reads.push("current");
        return "current" in options ? options.current : floor.minVersion;
      },
      streams: () => {
        reads.push("streams");
        if (options.streams === false) return undefined;
        return {
          peekSessionOutTail: async () => {
            if (outTail instanceof Error) throw outTail;
            return outTail;
          },
          readSessionInTailSeq: async () => 1,
        };
      },
      waiters: {
        listSessionInWaitpoints: async (key) => {
          reads.push(`waitpoints:${key}`);
          if (options.waitpointList) return options.waitpointList;
          if (options.waitpointIds) return options.waitpointIds;
          return (options.waitingRunIds ?? []).map((runId) => `waitpoint_${runId}`);
        },
        isWaitpointBlockingRun: async (waitpointId, runId) => {
          reads.push(`waitpoint:${waitpointId}`);
          if (options.blockingRead) return options.blockingRead;
          return waitpointId === `waitpoint_${runId}`;
        },
      },
    };
    return { reads, value };
  }

  const midReply: SessionOutTail = {
    kind: "record",
    control: undefined,
    timestamp: NOW,
    inConsumedSeq: undefined,
  };

  it("keeps a run at or above the floor, or without a version, without any check", async () => {
    const unread: LiveRunFloorChecks = {
      currentDeploymentVersion: notRead,
      streams: () => {
        throw new Error("not read");
      },
      waiters: { listSessionInWaitpoints: notRead, isWaitpointBlockingRun: notRead },
    };
    for (const taskVersion of ["20261108.2", "20261109.1", null]) {
      await expect(
        shouldSupersedeLiveRun(floor, { ...oldRun, taskVersion }, "chat_1", unread, NOW)
      ).resolves.toEqual({ supersede: false, reason: "at-or-above" });
    }
  });

  it("keeps an idle run while the current deployment is below the floor or missing", async () => {
    for (const current of ["20261101.1", undefined]) {
      const { reads, value } = checks({ current });
      await expect(shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW)).resolves.toEqual({
        supersede: false,
        reason: "current-below-floor",
        currentVersion: current,
      });
      expect(reads).toEqual(["streams", "current"]);
    }
  });

  it("supersedes an idle run once the current deployment is at or above the floor, without reading the waitpoints", async () => {
    for (const current of ["20261108.2", "20261109.1"]) {
      const { reads, value } = checks({ current });
      await expect(shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW)).resolves.toEqual({
        supersede: true,
      });
      expect(reads).toEqual(["streams", "current"]);
    }
  });

  it("keeps a busy run without reading the current deployment, even when it is below the floor", async () => {
    for (const current of ["20261101.1", "20261109.1"]) {
      const { reads, value } = checks({ current, outTail: midReply });
      await expect(shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW)).resolves.toEqual({
        supersede: false,
        reason: "busy",
      });
      expect(reads).not.toContain("current");
    }
  });

  it("keeps a run mid-reply unless it is waiting on its session's .in", async () => {
    const busy = checks({ outTail: midReply, waitingRunIds: ["run_other"] });
    await expect(shouldSupersedeLiveRun(floor, oldRun, "chat_1", busy.value, NOW)).resolves.toEqual(
      { supersede: false, reason: "busy" }
    );
    expect(busy.reads).toContain("waitpoints:chat_1");

    const waiting = checks({ outTail: midReply, waitingRunIds: [oldRun.id] });
    await expect(
      shouldSupersedeLiveRun(floor, oldRun, "chat_1", waiting.value, NOW)
    ).resolves.toEqual({ supersede: true });
  });

  it("keeps the run as check-failed when listing the .in waitpoints hangs", async () => {
    vi.useFakeTimers();
    try {
      const { reads, value } = checks({
        outTail: midReply,
        waitpointList: new Promise<string[]>(() => {}),
      });
      const decision = shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW);
      await vi.advanceTimersByTimeAsync(SESSION_IN_WAITPOINT_CHECK_TIMEOUT_MS);
      await expect(decision).resolves.toMatchObject({
        supersede: false,
        reason: "check-failed",
        error: { message: expect.stringContaining("timed out") },
      });
      expect(reads).not.toContain("current");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the run as check-failed when a waitpoint read hangs past the budget", async () => {
    vi.useFakeTimers();
    try {
      const { reads, value } = checks({
        outTail: midReply,
        waitingRunIds: [oldRun.id],
        blockingRead: new Promise<boolean>(() => {}),
      });
      const decision = shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW);
      await vi.advanceTimersByTimeAsync(SESSION_IN_WAITPOINT_CHECK_TIMEOUT_MS);
      await expect(decision).resolves.toMatchObject({
        supersede: false,
        reason: "check-failed",
        error: { message: expect.stringContaining("timed out") },
      });
      expect(reads).toContain(`waitpoint:waitpoint_${oldRun.id}`);
      expect(reads).not.toContain("current");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the run as check-failed without reading the waitpoints when .in has more than the cap", async () => {
    const waitpointIds = Array.from({ length: SESSION_IN_WAITPOINT_CHECK_MAX_IDS + 1 }, (_, i) =>
      i === 0 ? `waitpoint_${oldRun.id}` : `waitpoint_${i}`
    );
    const { reads, value } = checks({ outTail: midReply, waitpointIds });
    await expect(
      shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW)
    ).resolves.toMatchObject({
      supersede: false,
      reason: "check-failed",
      error: { message: expect.stringContaining("more than the 20 checked") },
    });
    expect(reads.filter((read) => read.startsWith("waitpoint:"))).toEqual([]);
    expect(reads).not.toContain("current");
  });

  it("checks every waitpoint up to the cap", async () => {
    const waitpointIds = Array.from({ length: SESSION_IN_WAITPOINT_CHECK_MAX_IDS }, (_, i) =>
      i === SESSION_IN_WAITPOINT_CHECK_MAX_IDS - 1 ? `waitpoint_${oldRun.id}` : `waitpoint_${i}`
    );
    const { value } = checks({ outTail: midReply, waitpointIds });
    await expect(shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW)).resolves.toEqual({
      supersede: true,
    });
  });

  it("keeps the run when there are no S2 streams to read", async () => {
    const { value } = checks({ streams: false });
    await expect(shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW)).resolves.toEqual({
      supersede: false,
      reason: "busy",
    });
  });

  it("keeps the run when a stream check fails, without reading the current deployment", async () => {
    const error = new Error("S2 unavailable");
    const { reads, value } = checks({ outTail: error });
    await expect(shouldSupersedeLiveRun(floor, oldRun, "chat_1", value, NOW)).resolves.toEqual({
      supersede: false,
      reason: "check-failed",
      error,
    });
    expect(reads).not.toContain("current");
  });
});

describe("basePayloadHasMessage", () => {
  it("is true only when the base payload carries a message or messages", () => {
    expect(basePayloadHasMessage({ basePayload: { message: { id: "m1" } } })).toBe(true);
    expect(basePayloadHasMessage({ basePayload: { messages: [] } })).toBe(true);
    expect(basePayloadHasMessage({ basePayload: { chatId: "c1", trigger: "preload" } })).toBe(
      false
    );
    expect(basePayloadHasMessage({ basePayload: { message: null } })).toBe(false);
    expect(basePayloadHasMessage({})).toBe(false);
    expect(basePayloadHasMessage(null)).toBe(false);
  });
});

describe("areSessionStreamsIdle", () => {
  const OLD_RUN = {
    createdAt: new Date(NOW - NEVER_MESSAGED_IDLE_MS - 1),
    startedWithMessage: false,
  };
  const YOUNG_RUN = {
    createdAt: new Date(NOW - NEVER_MESSAGED_IDLE_MS + 1),
    startedWithMessage: false,
  };

  function streams(outTail: SessionOutTail | Error, inTailSeq: number | undefined) {
    const inReads: string[] = [];
    return {
      inReads,
      peekSessionOutTail: async () => {
        if (outTail instanceof Error) throw outTail;
        return outTail;
      },
      readSessionInTailSeq: async (key: string) => {
        inReads.push(key);
        return inTailSeq;
      },
    };
  }

  it("is idle when the turn completed past the grace and .in has nothing unconsumed", async () => {
    await expect(
      areSessionStreamsIdle(
        streams(turnComplete(TURN_COMPLETE_GRACE_MS + 1, 3), 4),
        "chat_1",
        OLD_RUN,
        NOW
      )
    ).resolves.toBe(true);
  });

  it("is busy while the turn-complete is younger than the grace, without reading .in", async () => {
    const tails = streams(turnComplete(TURN_COMPLETE_GRACE_MS - 1, 3), 4);
    await expect(areSessionStreamsIdle(tails, "chat_1", OLD_RUN, NOW)).resolves.toBe(false);
    expect(tails.inReads).toEqual([]);
  });

  it("is busy when .in has a record past the consumed id", async () => {
    await expect(
      areSessionStreamsIdle(
        streams(turnComplete(TURN_COMPLETE_GRACE_MS + 1, 3), 5),
        "chat_1",
        OLD_RUN,
        NOW
      )
    ).resolves.toBe(false);
  });

  it("is busy when a turn-complete without a consumed id is followed by any .in record", async () => {
    const old = TURN_COMPLETE_GRACE_MS + 1;
    await expect(
      areSessionStreamsIdle(streams(turnComplete(old, undefined), 0), "chat_1", OLD_RUN, NOW)
    ).resolves.toBe(true);
    await expect(
      areSessionStreamsIdle(streams(turnComplete(old, undefined), 1), "chat_1", OLD_RUN, NOW)
    ).resolves.toBe(false);
  });

  it("is busy when the .in tail can't be read", async () => {
    await expect(
      areSessionStreamsIdle(
        streams(turnComplete(TURN_COMPLETE_GRACE_MS + 1, 3), undefined),
        "chat_1",
        OLD_RUN,
        NOW
      )
    ).resolves.toBe(false);
  });

  it("is busy mid-reply or when .out can't be read", async () => {
    const midReply: SessionOutTail = {
      kind: "record",
      control: undefined,
      timestamp: NOW - 60_000,
      inConsumedSeq: undefined,
    };
    for (const outTail of [midReply, { kind: "unknown" } as const]) {
      await expect(
        areSessionStreamsIdle(streams(outTail, 0), "chat_1", OLD_RUN, NOW)
      ).resolves.toBe(false);
    }
  });

  it("is idle with an empty .out and .in once the run is older than the first-turn wait", async () => {
    await expect(
      areSessionStreamsIdle(streams({ kind: "empty" }, 0), "chat_1", OLD_RUN, NOW)
    ).resolves.toBe(true);
  });

  it("is busy with an empty .out while the run is young, without reading .in", async () => {
    const tails = streams({ kind: "empty" }, 0);
    await expect(areSessionStreamsIdle(tails, "chat_1", YOUNG_RUN, NOW)).resolves.toBe(false);
    expect(tails.inReads).toEqual([]);
  });

  it("is busy with an empty .out at any age when the session started with a message, without reading .in", async () => {
    for (const ageMs of [NEVER_MESSAGED_IDLE_MS + 1, 24 * 60 * 60 * 1000]) {
      const tails = streams({ kind: "empty" }, 0);
      await expect(
        areSessionStreamsIdle(
          tails,
          "chat_1",
          { createdAt: new Date(NOW - ageMs), startedWithMessage: true },
          NOW
        )
      ).resolves.toBe(false);
      expect(tails.inReads).toEqual([]);
    }
  });

  it("is busy with an empty .out when .in has a record or can't be read", async () => {
    for (const inTailSeq of [1, undefined]) {
      await expect(
        areSessionStreamsIdle(streams({ kind: "empty" }, inTailSeq), "chat_1", OLD_RUN, NOW)
      ).resolves.toBe(false);
    }
  });
});
