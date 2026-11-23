import { describe, expect, it } from "vitest";
import {
  currentSessionDetails,
  mergeSessionRunEntries,
  SESSION_DETAILS_RUNS,
  type PolledSessionRun,
  type SessionDetailsData,
  type SessionRead,
  type SessionRunEntry,
} from "~/components/sessions/v1/sessionDetails";
import { SessionPanelStore } from "~/components/sessions/v1/trace/sessionPanelStore";
import type { SessionRunsSessionFacts } from "~/presenters/v3/SessionRunsPresenter.server";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const MINUTE = 60_000;
const iso = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

const entry = (
  n: number,
  status: "COMPLETED_SUCCESSFULLY" | "EXECUTING" = "COMPLETED_SUCCESSFULLY"
) =>
  ({
    id: `sr_${n}`,
    runFriendlyId: `run_${n}`,
    reason: n === 1 ? "initial" : "continuation",
    triggeredAt: iso(n),
    run: { friendlyId: `run_${n}`, status },
  }) satisfies SessionRunEntry;

const polled = (n: number, status: PolledSessionRun["status"] = "COMPLETED_SUCCESSFULLY") =>
  ({
    friendlyId: `run_${n}`,
    reason: n === 1 ? "initial" : "continuation",
    triggeredAt: iso(n),
    status,
  }) satisfies PolledSessionRun;

const facts = (extra: Partial<SessionRunsSessionFacts> = {}): SessionRunsSessionFacts => ({
  closedAt: null,
  closedReason: null,
  expiresAt: null,
  updatedAt: iso(2),
  currentRunFriendlyId: "run_2",
  ...extra,
});

const loaded: SessionDetailsData = {
  updatedAt: iso(2),
  currentRun: { friendlyId: "run_2", status: "EXECUTING" },
  runs: [entry(2, "EXECUTING"), entry(1)],
};

const read = (extra: Partial<SessionRead> = {}): SessionRead => ({
  facts: facts(),
  runs: [polled(2), polled(1)],
  ...extra,
});

describe("currentSessionDetails", () => {
  it("shows the page load until the Trace tab has read the session", () => {
    expect(currentSessionDetails(loaded, undefined)).toBe(loaded);
  });

  // Catches: the details missing a new run that the Trace tab's poll found.
  it("shows a new run and moves the current run to it", () => {
    const details = currentSessionDetails(
      loaded,
      read({
        facts: facts({ currentRunFriendlyId: "run_3" }),
        runs: [polled(3, "EXECUTING"), polled(2), polled(1)],
      })
    );

    expect(details.runs.map((r) => r.runFriendlyId)).toEqual(["run_3", "run_2", "run_1"]);
    expect(details.currentRun).toEqual({ friendlyId: "run_3", status: "EXECUTING" });
  });

  // Catches: the current run's status staying as the page loaded it.
  // A poll with the same session row as the page load may still have newer run statuses.
  it("updates the current run's status", () => {
    const details = currentSessionDetails(loaded, read());

    expect(details.currentRun).toEqual({ friendlyId: "run_2", status: "COMPLETED_SUCCESSFULLY" });
    expect(details.runs[0]?.run?.status).toBe("COMPLETED_SUCCESSFULLY");
  });

  // Catches: a session closed by the agent or the API still showing as open.
  it("shows a session the poll saw closed", () => {
    const details = currentSessionDetails(
      loaded,
      read({ facts: facts({ closedAt: iso(5), closedReason: "done", updatedAt: iso(5) }) })
    );

    expect(details).toMatchObject({ closedAt: iso(5), closedReason: "done", updatedAt: iso(5) });
  });

  // Catches: Close session reloading the page, then an older poll (open) hiding the close.
  it("a page load after the last read wins", () => {
    const reloaded = {
      ...loaded,
      closedAt: iso(5),
      closedReason: "closed by user",
      updatedAt: iso(5),
    };

    expect(currentSessionDetails(reloaded, read())).toBe(reloaded);
  });

  it("a current run outside the polled runs keeps the page load's status, or none", () => {
    const sameRun = currentSessionDetails(loaded, read({ runs: [] }));
    expect(sameRun.currentRun).toEqual({ friendlyId: "run_2", status: "EXECUTING" });

    const otherRun = currentSessionDetails(
      loaded,
      read({ facts: facts({ currentRunFriendlyId: "run_9" }), runs: [] })
    );
    expect(otherRun.currentRun).toEqual({ friendlyId: "run_9", status: null });

    const none = currentSessionDetails(
      loaded,
      read({ facts: facts({ currentRunFriendlyId: null }) })
    );
    expect(none.currentRun).toBeNull();
  });
});

describe("mergeSessionRunEntries", () => {
  it("keeps the page load's key and takes the polled status", () => {
    const merged = mergeSessionRunEntries([entry(1, "EXECUTING")], [polled(1)]);
    expect(merged).toEqual([{ ...entry(1), id: "sr_1" }]);
  });

  // Catches: a run the runs route drops (another environment) losing what the page load showed.
  it("keeps a run the poll can't see", () => {
    const merged = mergeSessionRunEntries([entry(1)], [polled(1, null)]);
    expect(merged[0]?.run).toEqual({ friendlyId: "run_1", status: "COMPLETED_SUCCESSFULLY" });
  });

  it("keeps rows with no run, and runs older than the polled page", () => {
    const missing = { ...entry(1), run: null };
    const merged = mergeSessionRunEntries([entry(2), missing], [polled(3)]);

    expect(merged.map((r) => [r.runFriendlyId, r.run?.status ?? null])).toEqual([
      ["run_3", "COMPLETED_SUCCESSFULLY"],
      ["run_2", "COMPLETED_SUCCESSFULLY"],
      ["run_1", null],
    ]);
  });

  it(`shows at most ${SESSION_DETAILS_RUNS}, newest first`, () => {
    const page = Array.from({ length: SESSION_DETAILS_RUNS }, (_, i) =>
      entry(SESSION_DETAILS_RUNS - i)
    );
    const merged = mergeSessionRunEntries(page, [polled(SESSION_DETAILS_RUNS + 1)]);

    expect(merged).toHaveLength(SESSION_DETAILS_RUNS);
    expect(merged[0]?.runFriendlyId).toBe(`run_${SESSION_DETAILS_RUNS + 1}`);
    expect(merged.at(-1)?.runFriendlyId).toBe("run_2");
  });
});

describe("SessionPanelStore session read", () => {
  // Catches: every quiet poll re-rendering the session details.
  it("a read that changes nothing doesn't notify", () => {
    const store = new SessionPanelStore();
    let notified = 0;
    store.subscribe(() => notified++);
    const runs = [polled(1)];

    store.setSessionRead(facts(), runs);
    const first = store.getSessionRead();
    store.setSessionRead(facts(), runs);

    expect(notified).toBe(1);
    expect(store.getSessionRead()).toBe(first);

    store.setSessionRead(facts({ closedAt: iso(5) }), runs);
    store.setSessionRead(facts({ closedAt: iso(5) }), [polled(2), polled(1)]);
    expect(notified).toBe(3);
  });
});
