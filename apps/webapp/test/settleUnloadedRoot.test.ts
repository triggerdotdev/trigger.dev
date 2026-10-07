import { describe, expect, it } from "vitest";
import { settleUnloadedRoot } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/settleUnloadedRoot";

const start = new Date("2026-10-01T10:00:00.000Z");
const completedAt = new Date("2026-10-01T10:00:06.000Z");
const SIX_SECONDS_NS = 6_000 * 1_000_000;

function event(id: string, data: Partial<ReturnType<typeof baseData>> = {}) {
  return { id, data: { ...baseData(), ...data } };
}

function baseData() {
  return {
    startTime: start as Date | string,
    duration: null as number | null,
    isPartial: true,
    isError: false,
    isCancelled: false,
  };
}

const loading = {
  events: [event("root"), event("child")],
  duration: 1_000_000,
  rootSpanStatus: "executing" as const,
  run: { status: "COMPLETED_SUCCESSFULLY" as const, completedAt },
};

describe("settleUnloadedRoot", () => {
  it("ends the root at completedAt for a finished run", () => {
    const result = settleUnloadedRoot(loading);

    expect(result.rootSpanStatus).toBe("completed");
    expect(result.duration).toBe(SIX_SECONDS_NS);
    expect(result.events[0].data).toMatchObject({
      isPartial: false,
      isError: false,
      isCancelled: false,
      duration: SIX_SECONDS_NS,
    });
  });

  it("leaves the children alone", () => {
    const result = settleUnloadedRoot(loading);
    expect(result.events[1]).toBe(loading.events[1]);
  });

  it("marks a failed run's root as errored", () => {
    const result = settleUnloadedRoot({
      ...loading,
      run: { status: "COMPLETED_WITH_ERRORS", completedAt },
    });
    expect(result.rootSpanStatus).toBe("failed");
    expect(result.events[0].data.isError).toBe(true);
  });

  it("marks a canceled run's root as canceled", () => {
    const result = settleUnloadedRoot({
      ...loading,
      run: { status: "CANCELED", completedAt },
    });
    expect(result.events[0].data.isCancelled).toBe(true);
  });

  it("accepts ISO strings from the loader", () => {
    const result = settleUnloadedRoot({
      ...loading,
      events: [event("root", { startTime: start.toISOString() })],
      run: { status: "COMPLETED_SUCCESSFULLY", completedAt: completedAt.toISOString() },
    });
    expect(result.duration).toBe(SIX_SECONDS_NS);
  });

  it("still settles once every chunk has loaded if the root's completion row never arrived", () => {
    const fullyLoadedEvents = [event("root"), event("child", { isPartial: false, duration: 5 })];
    const result = settleUnloadedRoot({ ...loading, events: fullyLoadedEvents });
    expect(result.rootSpanStatus).toBe("completed");
    expect(result.events[0].data.isPartial).toBe(false);
  });

  it("changes nothing while the run is still running", () => {
    const input = { ...loading, run: { status: "EXECUTING" as const, completedAt: null } };
    expect(settleUnloadedRoot(input).events).toBe(input.events);
  });

  it("changes nothing when the root already has its completion row", () => {
    const input = { ...loading, events: [event("root", { isPartial: false, duration: 5 })] };
    expect(settleUnloadedRoot(input).events).toBe(input.events);
  });

  it("marks an expired run's root as errored, like its completion row would", () => {
    const result = settleUnloadedRoot({ ...loading, run: { status: "EXPIRED", completedAt } });
    expect(result.rootSpanStatus).toBe("failed");
    expect(result.events[0].data.isError).toBe(true);
  });

  it("changes nothing without completedAt, even with a final status", () => {
    const input = {
      ...loading,
      run: { status: "COMPLETED_SUCCESSFULLY" as const, completedAt: null },
    };
    expect(settleUnloadedRoot(input).events).toBe(input.events);
  });

  it("changes nothing for statuses that aren't final", () => {
    const input = { ...loading, run: { status: "PENDING_VERSION" as const, completedAt: null } };
    expect(settleUnloadedRoot(input).events).toBe(input.events);
  });
});
