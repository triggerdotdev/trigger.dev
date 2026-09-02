// The snapshot sweeper needs to know which run statuses are terminal, and it cannot import that
// list: run-engine depends on run-store, not the other way round. So the list is duplicated, and
// this is the only thing that keeps the copy honest.
//
// Without it, a status added here and not there makes the sweeper treat a finished run as live and
// never apply its completion expiry. A status removed here and not there makes it treat a live run
// as finished. The second one reaps state a run is still using.
import { describe, expect, it } from "vitest";
import { FINAL_RUN_STATUSES } from "@internal/run-store";
import { getFinalRunStatuses } from "../statuses.js";

describe("terminal run statuses", () => {
  it("match between the engine and the snapshot sweeper", () => {
    expect([...FINAL_RUN_STATUSES].sort()).toEqual([...getFinalRunStatuses()].sort());
  });

  it("are not empty, so the comparison cannot pass vacuously", () => {
    expect(FINAL_RUN_STATUSES.length).toBeGreaterThan(0);
  });
});
