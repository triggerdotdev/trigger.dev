import type { RunEngine } from "@internal/run-engine";
import type { RunStore } from "@internal/run-store";
import { tryCatch } from "@trigger.dev/core/v3";
import { isStoreDateTimeWaitpoint } from "~/services/dashboardDateTimeWaitpoint.server";
import { compareVersionParts } from "~/utils/semver";
import { FEATURE_FLAG, isPlainFlagObject, SessionVersionFloor } from "~/v3/featureFlags";
import type { SessionOutTail } from "./s2realtimeStreams.server";

export type { SessionVersionFloor };

type FloorEnvironment = {
  id: string;
  type: string;
  organization: { featureFlags: unknown };
};

export function sessionVersionFloorFor(
  environment: FloorEnvironment
): SessionVersionFloor | undefined {
  if (environment.type === "DEVELOPMENT") return undefined;

  const flags = environment.organization.featureFlags;
  if (!isPlainFlagObject(flags)) return undefined;

  const floors = flags[FEATURE_FLAG.sessionVersionFloor];
  if (!isPlainFlagObject(floors)) return undefined;

  const entry = floors[environment.id];
  if (entry === undefined) return undefined;

  const parsed = SessionVersionFloor.safeParse(entry);
  return parsed.success ? parsed.data : undefined;
}

export function isVersionBelowSessionVersionFloor(
  version: string,
  floor: SessionVersionFloor
): boolean {
  return compareVersionParts(version, floor.minVersion) < 0;
}

export const TURN_COMPLETE_GRACE_MS = 10_000;
export const NEVER_MESSAGED_IDLE_MS = 120_000;
export const SESSION_IN_WAITPOINT_CHECK_TIMEOUT_MS = 1_000;
export const SESSION_IN_WAITPOINT_CHECK_MAX_IDS = 20;

export function basePayloadHasMessage(triggerConfig: unknown): boolean {
  if (!isPlainFlagObject(triggerConfig)) return false;
  const basePayload = triggerConfig.basePayload;
  if (!isPlainFlagObject(basePayload)) return false;
  return basePayload.message != null || basePayload.messages != null;
}

export type SessionStreamTails = {
  peekSessionOutTail(addressingKey: string): Promise<SessionOutTail>;
  readSessionInTailSeq(addressingKey: string): Promise<number | undefined>;
};

export async function areSessionStreamsIdle(
  streams: SessionStreamTails,
  addressingKey: string,
  run: { createdAt: Date; startedWithMessage: boolean },
  now: number = Date.now()
): Promise<boolean> {
  const outTail = await streams.peekSessionOutTail(addressingKey);

  if (outTail.kind === "empty") {
    if (run.startedWithMessage) return false;
    if (now - run.createdAt.getTime() < NEVER_MESSAGED_IDLE_MS) return false;
    return (await streams.readSessionInTailSeq(addressingKey)) === 0;
  }

  if (outTail.kind !== "record" || outTail.control !== "turn-complete") return false;
  if (now - outTail.timestamp < TURN_COMPLETE_GRACE_MS) return false;

  const inTailSeq = await streams.readSessionInTailSeq(addressingKey);
  if (inTailSeq === undefined) return false;
  return inTailSeq <= (outTail.inConsumedSeq ?? -1) + 1;
}

function rejectAfter<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

type SessionInWaiters = {
  listSessionInWaitpoints(addressingKey: string): Promise<string[]>;
  isWaitpointBlockingRun(waitpointId: string, runId: string): Promise<boolean>;
};

/** One floor check's waitpoint test. Store-format ids share one read of the run's current blockers. */
export function waitpointBlockingRunCheck(
  environment: { id: string; projectId: string; organizationId: string },
  deps: {
    engine: Pick<RunEngine, "getStoreRunBlockingWaitpointIds" | "getStoreDateTimeWaitpoint">;
    runStore: Pick<RunStore, "findWaitpoint" | "findWaitpointConnectedRunIds">;
  }
): SessionInWaiters["isWaitpointBlockingRun"] {
  const storeBlockers = new Map<string, Promise<string[]>>();
  return async (waitpointId, runId) => {
    if (isStoreDateTimeWaitpoint(waitpointId)) {
      let blockers = storeBlockers.get(runId);
      if (!blockers) {
        blockers = deps.engine.getStoreRunBlockingWaitpointIds({
          runId,
          organizationId: environment.organizationId,
        });
        storeBlockers.set(runId, blockers);
      }
      if (!(await blockers).includes(waitpointId)) return false;
      // A completed waitpoint stays in the run's block until it is delivered, so check it too.
      const waitpoint = await deps.engine.getStoreDateTimeWaitpoint({
        waitpointId,
        environmentId: environment.id,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
      });
      return waitpoint?.status === "PENDING";
    }
    // Legacy ids keep their original read, which also counts a wait from an earlier attempt.
    const waitpoint = await deps.runStore.findWaitpoint({
      where: { id: waitpointId, environmentId: environment.id },
      select: { status: true },
    });
    if (waitpoint?.status !== "PENDING") return false;
    const runIds = await deps.runStore.findWaitpointConnectedRunIds(waitpointId);
    return runIds.includes(runId);
  };
}

async function isRunWaitingOnSessionIn(
  waiters: SessionInWaiters,
  addressingKey: string,
  runId: string
): Promise<boolean> {
  return rejectAfter(
    (async () => {
      const waitpointIds = await waiters.listSessionInWaitpoints(addressingKey);
      if (waitpointIds.length > SESSION_IN_WAITPOINT_CHECK_MAX_IDS) {
        throw new Error(
          `Session .in has ${waitpointIds.length} waitpoints, more than the ${SESSION_IN_WAITPOINT_CHECK_MAX_IDS} checked`
        );
      }
      for (const waitpointId of waitpointIds) {
        if (await waiters.isWaitpointBlockingRun(waitpointId, runId)) return true;
      }
      return false;
    })(),
    SESSION_IN_WAITPOINT_CHECK_TIMEOUT_MS,
    `Checking the .in waitpoints timed out after ${SESSION_IN_WAITPOINT_CHECK_TIMEOUT_MS}ms`
  );
}

export type LiveRunFloorChecks = {
  currentDeploymentVersion(): Promise<string | undefined>;
  streams(): SessionStreamTails | undefined;
  waiters: SessionInWaiters;
};

export type SupersedeDecision =
  | { supersede: true }
  | { supersede: false; reason: "at-or-above" | "busy" }
  | { supersede: false; reason: "current-below-floor"; currentVersion: string | undefined }
  | { supersede: false; reason: "check-failed"; error: Error };

export async function shouldSupersedeLiveRun(
  floor: SessionVersionFloor,
  run: { id: string; taskVersion: string | null; createdAt: Date; startedWithMessage: boolean },
  addressingKey: string,
  checks: LiveRunFloorChecks,
  now: number = Date.now()
): Promise<SupersedeDecision> {
  if (run.taskVersion === null || !isVersionBelowSessionVersionFloor(run.taskVersion, floor)) {
    return { supersede: false, reason: "at-or-above" };
  }

  const [error, idle] = await tryCatch(
    (async () => {
      const streams = checks.streams();
      if (!streams) return false;
      if (await areSessionStreamsIdle(streams, addressingKey, run, now)) return true;
      return isRunWaitingOnSessionIn(checks.waiters, addressingKey, run.id);
    })()
  );
  if (error) return { supersede: false, reason: "check-failed", error };
  if (!idle) return { supersede: false, reason: "busy" };

  const currentVersion = await checks.currentDeploymentVersion();
  if (!currentVersion || isVersionBelowSessionVersionFloor(currentVersion, floor)) {
    return { supersede: false, reason: "current-below-floor", currentVersion };
  }

  return { supersede: true };
}
