import { describe, it, expect } from "vitest";
import { fromContext, wideEventStorage } from "./context.js";
import { recordPhase, recordPhaseSince, timePhase } from "./record.js";
import { newState } from "./new.js";
import type { State } from "./state.js";

function makeState(): State {
  return newState({ service: "test", env: {} });
}

describe("recordPhase", () => {
  it("appends a successful phase", () => {
    const s = makeState();
    recordPhase(s, "lookup", performance.now() - 50, undefined);
    expect(s.phases).toHaveLength(1);
    const phase = s.phases[0];
    if (!phase) throw new Error("missing phase");
    expect(phase.name).toBe("lookup");
    expect(phase.ok).toBe(true);
    expect(phase.attempts).toBe(1);
    expect(phase.durationMs).toBeGreaterThanOrEqual(45);
  });

  it("appends a failed phase with error code/message", () => {
    const s = makeState();
    recordPhase(s, "dispatch", performance.now(), new Error("nope"));
    const phase = s.phases[0];
    if (!phase) throw new Error("missing phase");
    expect(phase.ok).toBe(false);
    expect(phase.errorCode).toBe("Error");
    expect(phase.errorMsg).toBe("nope");
  });

  it("truncates very long error messages", () => {
    const s = makeState();
    recordPhase(s, "x", performance.now(), new Error("y".repeat(2000)));
    const phase = s.phases[0];
    if (!phase) throw new Error("missing phase");
    expect(phase.errorMsg?.length).toBe(512);
  });

  it("honours opts.attempts", () => {
    const s = makeState();
    recordPhase(s, "retry", performance.now(), undefined, { attempts: 3 });
    expect(s.phases[0]?.attempts).toBe(3);
  });

  it("attaches sub-timings", () => {
    const s = makeState();
    recordPhase(s, "complex", performance.now(), undefined, { sub: { setup_ms: 10, work_ms: 5 } });
    expect(s.phases[0]?.sub).toEqual({ setup_ms: 10, work_ms: 5 });
  });

  it("is a no-op when state is null", () => {
    expect(() => recordPhase(null, "x", performance.now(), undefined)).not.toThrow();
  });
});

describe("timePhase + AsyncLocalStorage threading", () => {
  it("records via fromContext on success", async () => {
    const s = makeState();
    const value = await wideEventStorage.run(s, () => timePhase("work", async () => 42));
    expect(value).toBe(42);
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0]?.ok).toBe(true);
  });

  it("records via fromContext on error and rethrows", async () => {
    const s = makeState();
    await expect(
      wideEventStorage.run(s, () =>
        timePhase("work", async () => {
          throw new Error("boom");
        })
      )
    ).rejects.toThrow("boom");
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0]?.ok).toBe(false);
    expect(s.phases[0]?.errorMsg).toBe("boom");
  });

  it("runs fn unchanged when no state on context", async () => {
    const value = await timePhase("work", async () => "ok");
    expect(value).toBe("ok");
  });
});

describe("recordPhaseSince", () => {
  it("records using a caller-captured start time", async () => {
    const s = makeState();
    await wideEventStorage.run(s, async () => {
      const start = performance.now();
      await new Promise((r) => setTimeout(r, 10));
      recordPhaseSince("spanning", start, undefined);
    });
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0]?.durationMs).toBeGreaterThanOrEqual(8);
  });
});

describe("fromContext", () => {
  it("returns null when no state attached", () => {
    expect(fromContext()).toBe(null);
  });

  it("returns the state when inside wideEventStorage.run", () => {
    const s = makeState();
    wideEventStorage.run(s, () => {
      expect(fromContext()).toBe(s);
    });
  });
});
