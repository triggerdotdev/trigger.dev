import { afterEach, describe, expect, it } from "vitest";
import { createSnapshotStoreMetrics } from "~/v3/snapshotStoreMetrics.server";
import { createInMemoryMetrics } from "./utils/tracing";
import { latestMetrics, metricSum } from "./otlpMetrics.helpers";

const COHORT = "org_soak";

describe("snapshot store metrics per-org label", () => {
  let helper: ReturnType<typeof createInMemoryMetrics> | undefined;

  afterEach(async () => {
    await helper?.shutdown();
    helper = undefined;
  });

  it("labels a cohort org's append with its own id and a non-member with 'other'", async () => {
    helper = createInMemoryMetrics();
    const { store } = createSnapshotStoreMetrics(helper.meter, (orgId) => orgId === COHORT);

    store.recordAppend("written", "none", COHORT);
    store.recordAppend("written", "none", "org_other");
    store.recordAppend("written", "none", undefined);

    const metrics = await latestMetrics(helper);
    expect(
      metricSum(metrics, "run_engine.snapshot_store.append_total", {
        outcome: "written",
        org: COHORT,
      })
    ).toBe(1);
    expect(
      metricSum(metrics, "run_engine.snapshot_store.append_total", {
        outcome: "written",
        org: "other",
      })
    ).toBe(2);
  });

  it("labels appendFailed with the cohort org id, else 'other'", async () => {
    helper = createInMemoryMetrics();
    const { decorator } = createSnapshotStoreMetrics(helper.meter, (orgId) => orgId === COHORT);

    decorator.recordAppendFailed("createRun", COHORT);
    decorator.recordAppendFailed("createRun", "org_other");

    const metrics = await latestMetrics(helper);
    expect(
      metricSum(metrics, "run_engine.snapshot_store.append_failed", {
        site: "createRun",
        org: COHORT,
      })
    ).toBe(1);
    expect(
      metricSum(metrics, "run_engine.snapshot_store.append_failed", {
        site: "createRun",
        org: "other",
      })
    ).toBe(1);
  });

  it("defaults every org to 'other' when no cohort predicate is supplied", async () => {
    helper = createInMemoryMetrics();
    const { store } = createSnapshotStoreMetrics(helper.meter);

    store.recordAppend("written", "none", COHORT);

    const metrics = await latestMetrics(helper);
    expect(
      metricSum(metrics, "run_engine.snapshot_store.append_total", {
        outcome: "written",
        org: COHORT,
      })
    ).toBe(0);
    expect(
      metricSum(metrics, "run_engine.snapshot_store.append_total", {
        outcome: "written",
        org: "other",
      })
    ).toBe(1);
  });
});
