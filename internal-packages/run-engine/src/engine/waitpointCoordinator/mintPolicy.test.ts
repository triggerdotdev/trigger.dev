// Pure decision logic, so no container. This is the ONLY place the "where does a NEW waitpoint
// get minted" question is answered; every store-vs-legacy consequence downstream is a routing
// decision made from the id shape the mint here produced.
import { describe, expect, it } from "vitest";
import type { SnapshotResidency } from "@internal/run-store";
import {
  DEFAULT_ELIGIBLE_WAITPOINT_TYPES,
  decideWaitpointResidency,
  type WaitpointMintDecisionInput,
  type WaitpointMintMode,
  type WaitpointMintType,
} from "./mintPolicy.js";

const ALL_MODES: WaitpointMintMode[] = ["legacy", "redis"];
const ALL_ROUTES: Array<SnapshotResidency | undefined> = [
  "postgres",
  "mirrored",
  "redis-primary",
  undefined,
];
const ALL_TYPES: WaitpointMintType[] = ["RUN", "BATCH", "DATETIME", "MANUAL"];

function input(overrides: Partial<WaitpointMintDecisionInput> = {}): WaitpointMintDecisionInput {
  return {
    mintMode: "redis",
    parentResidency: "redis-primary",
    waitpointType: "RUN",
    capabilityReady: true,
    ...overrides,
  };
}

describe("decideWaitpointResidency — exhaustive mint matrix", () => {
  // TRES snapshot residency never changes a mint decision.
  it("mints store for every snapshot residency when redis mode, eligible type and capability are ready", () => {
    for (const mode of ALL_MODES) {
      for (const route of ALL_ROUTES) {
        for (const type of ALL_TYPES) {
          for (const ready of [true, false]) {
            const decision = decideWaitpointResidency(
              input({
                mintMode: mode,
                parentResidency: route,
                waitpointType: type,
                capabilityReady: ready,
              })
            );

            const shouldBeStore =
              mode === "redis" && DEFAULT_ELIGIBLE_WAITPOINT_TYPES.has(type) && ready === true;

            const reason =
              mode === "legacy"
                ? "org-disabled"
                : !DEFAULT_ELIGIBLE_WAITPOINT_TYPES.has(type)
                  ? "ineligible-type"
                  : !ready
                    ? "capability-not-ready"
                    : "enabled";
            expect(decision, `mode=${mode} route=${route} type=${type} ready=${ready}`).toEqual({
              residency: shouldBeStore ? "store" : "legacy",
              reason,
            });
          }
        }
      }
    }
  });

  it("redis mode + ineligible type mints legacy (ineligible-type)", () => {
    const ineligible: WaitpointMintType = "MANUAL";
    const decision = decideWaitpointResidency(
      input({ waitpointType: ineligible, eligibleTypes: new Set<WaitpointMintType>(["RUN"]) })
    );
    expect(decision.residency).toBe("legacy");
    expect(decision.reason).toBe("ineligible-type");
  });

  it("is pure: does not mutate its input", () => {
    const original = input();
    const snapshot = JSON.parse(JSON.stringify({ ...original, eligibleTypes: undefined }));
    decideWaitpointResidency(original);
    expect(JSON.parse(JSON.stringify({ ...original, eligibleTypes: undefined }))).toEqual(snapshot);
  });
});

describe("DEFAULT_ELIGIBLE_WAITPOINT_TYPES", () => {
  it("targets RUN and DATETIME while MANUAL and BATCH migration is deferred", () => {
    expect([...DEFAULT_ELIGIBLE_WAITPOINT_TYPES]).toEqual(["RUN", "DATETIME"]);
  });

  it("preserves explicit eligibility overrides for a caller that owns its migration", () => {
    for (const waitpointType of ["MANUAL", "BATCH"] as const) {
      expect(
        decideWaitpointResidency(input({ waitpointType, eligibleTypes: new Set([waitpointType]) }))
      ).toEqual({ residency: "store", reason: "enabled" });
    }
  });
});
