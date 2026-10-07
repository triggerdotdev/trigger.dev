import { describe, expect, it } from "vitest";
import {
  getTraceStatus,
  type TraceStatus,
  type TraceStatusInput,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/traceStatus";

const liveRun: TraceStatusInput = {
  runFinished: false,
  rootSpanStatus: "executing",
  isComplete: true,
  isTruncated: false,
  missingAnchor: false,
  loadFailed: false,
  isLiveReloading: true,
  liveTailEnabled: true,
  maximumLiveReloadingSetting: 1000,
};

const finishedRun: TraceStatusInput = {
  ...liveRun,
  runFinished: true,
  rootSpanStatus: "completed",
  isLiveReloading: false,
};

function reasonOf(status: TraceStatus): string {
  return "reason" in status ? status.reason : "";
}

describe("getTraceStatus", () => {
  it("is live while the run executes and live reload is on", () => {
    expect(getTraceStatus(liveRun)).toEqual({ kind: "live" });
  });

  it("is all loaded once the run has finished", () => {
    expect(getTraceStatus(finishedRun)).toEqual({ kind: "allLoaded" });
  });

  it("treats the run as finished when only the root span says so", () => {
    expect(getTraceStatus({ ...liveRun, rootSpanStatus: "failed" })).toEqual({
      kind: "allLoaded",
    });
  });

  it("treats the run as finished when only the run row says so", () => {
    expect(getTraceStatus({ ...liveRun, runFinished: true })).toEqual({ kind: "allLoaded" });
  });

  it("shows loading, not live reload state, while chunks load on a finished run", () => {
    expect(
      getTraceStatus({ ...finishedRun, rootSpanStatus: "executing", isComplete: false }).kind
    ).toBe("loading");
  });

  it("shows loading before live on an executing run", () => {
    expect(getTraceStatus({ ...liveRun, isComplete: false }).kind).toBe("loading");
  });

  it("puts a failed chunk load ahead of everything except truncation", () => {
    expect(getTraceStatus({ ...liveRun, loadFailed: true, isLiveReloading: false }).kind).toBe(
      "failed"
    );
    expect(
      getTraceStatus({ ...liveRun, loadFailed: true, isTruncated: true, isLiveReloading: false })
        .kind
    ).toBe("partial");
  });

  it("only mentions paused live updates when live reload has actually stopped", () => {
    const stopped = getTraceStatus({ ...liveRun, loadFailed: true, isLiveReloading: false });
    const finished = getTraceStatus({ ...finishedRun, loadFailed: true });
    expect(reasonOf(stopped)).toContain("paused");
    expect(reasonOf(finished)).not.toContain("paused");
  });

  it("is partial when the trace is truncated, live or not", () => {
    const live = getTraceStatus({ ...liveRun, isTruncated: true, isLiveReloading: false });
    const finished = getTraceStatus({ ...finishedRun, isTruncated: true });
    expect(live.kind).toBe("partial");
    expect(finished.kind).toBe("partial");
    expect(reasonOf(live)).toContain("Live updates are off");
    expect(reasonOf(finished)).not.toContain("Live updates");
  });

  it("doesn't claim live updates are off while the legacy path still reloads", () => {
    const legacy = getTraceStatus({ ...liveRun, liveTailEnabled: false, isTruncated: true });
    expect(legacy.kind).toBe("partial");
    expect(reasonOf(legacy)).not.toContain("Live updates");
  });

  it("says too large when the root couldn't be anchored", () => {
    const status = getTraceStatus({ ...finishedRun, isTruncated: true, missingAnchor: true });
    expect(reasonOf(status)).toContain("This trace is too large to display.");
  });

  it("warns that search and filters may be incomplete until the trace is fully loaded", () => {
    const states = [
      getTraceStatus({ ...liveRun, isComplete: false }),
      getTraceStatus({ ...finishedRun, isTruncated: true }),
      getTraceStatus({ ...finishedRun, loadFailed: true }),
    ];
    for (const status of states) {
      expect(reasonOf(status)).toContain("Search and filters may be incomplete");
    }
  });

  it("explains the legacy size cap when live updates are off", () => {
    const status = getTraceStatus({
      ...liveRun,
      liveTailEnabled: false,
      isLiveReloading: false,
      maximumLiveReloadingSetting: 1000,
    });
    expect(status.kind).toBe("liveOff");
    expect(reasonOf(status)).toContain("1000 spans");
  });

  it("shows nothing when the tail is on but not reloading an executing run", () => {
    expect(getTraceStatus({ ...liveRun, isLiveReloading: false })).toEqual({ kind: "none" });
  });
});
