// A matcher that is too loose is the dangerous failure: it answers a query Redis cannot actually
// serve, and the caller gets a wrong answer rather than a slow one. So most of these tests are
// about what must NOT match.
import { describe, expect, it } from "vitest";
import { matchSinceCursorLookup, matchSinceWindow } from "./snapshotReadShapes.js";

const cursorArgs = {
  where: { id: "snap_1", runId: "run_1" },
  select: { createdAt: true },
};

const windowArgs = {
  where: { runId: "run_1", isValid: true, createdAt: { gt: new Date("2026-08-24T00:00:00Z") } },
  include: { checkpoint: true },
  orderBy: { createdAt: "desc" },
  take: 50,
};

describe("matchSinceCursorLookup", () => {
  it("matches the engine's since-cursor lookup", () => {
    expect(matchSinceCursorLookup(cursorArgs)).toEqual({ id: "snap_1", runId: "run_1" });
  });

  it("carries an environment scope when present", () => {
    expect(
      matchSinceCursorLookup({
        where: { ...cursorArgs.where, environmentId: "env_1" },
        select: { createdAt: true },
      })
    ).toEqual({ id: "snap_1", runId: "run_1", environmentId: "env_1" });
  });

  it("ignores keys explicitly set to undefined", () => {
    expect(
      matchSinceCursorLookup({
        where: { ...cursorArgs.where, environmentId: undefined },
        select: { createdAt: true },
      })
    ).toEqual({ id: "snap_1", runId: "run_1" });
  });

  it("refuses a selection of anything but createdAt", () => {
    expect(
      matchSinceCursorLookup({ where: cursorArgs.where, select: { description: true } })
    ).toBeUndefined();
    expect(
      matchSinceCursorLookup({
        where: cursorArgs.where,
        select: { createdAt: true, description: true },
      })
    ).toBeUndefined();
  });

  it("refuses a where with no run id, because there is no keyspace to look in", () => {
    expect(
      matchSinceCursorLookup({ where: { id: "snap_1" }, select: { createdAt: true } })
    ).toBeUndefined();
  });

  it("refuses an unknown where key", () => {
    expect(
      matchSinceCursorLookup({
        where: { ...cursorArgs.where, isValid: true },
        select: { createdAt: true },
      })
    ).toBeUndefined();
  });

  it("refuses an unknown top-level key", () => {
    expect(matchSinceCursorLookup({ ...cursorArgs, orderBy: { createdAt: "desc" } })).toBeUndefined();
  });

  it("refuses anything that is not an argument object", () => {
    expect(matchSinceCursorLookup(undefined)).toBeUndefined();
    expect(matchSinceCursorLookup(null)).toBeUndefined();
    expect(matchSinceCursorLookup("where")).toBeUndefined();
    expect(matchSinceCursorLookup([cursorArgs])).toBeUndefined();
  });
});

describe("matchSinceWindow", () => {
  it("matches the engine's window query", () => {
    expect(matchSinceWindow(windowArgs)).toEqual({
      runId: "run_1",
      createdAt: new Date("2026-08-24T00:00:00Z"),
      take: 50,
    });
  });

  it("carries an environment scope when present", () => {
    expect(
      matchSinceWindow({
        ...windowArgs,
        where: { ...windowArgs.where, environmentId: "env_1" },
      })
    ).toMatchObject({ environmentId: "env_1" });
  });

  it("refuses a query that also wants the completed waitpoints", () => {
    // The engine omits them on purpose to avoid an N x M read. An include that asks for them is a
    // different query, and answering it from this path would return them empty.
    expect(
      matchSinceWindow({
        ...windowArgs,
        include: { checkpoint: true, completedWaitpoints: true },
      })
    ).toBeUndefined();
  });

  it("refuses ascending order", () => {
    expect(
      matchSinceWindow({ ...windowArgs, orderBy: { createdAt: "asc" } })
    ).toBeUndefined();
  });

  it("refuses a window that does not filter to valid entries", () => {
    expect(
      matchSinceWindow({ ...windowArgs, where: { ...windowArgs.where, isValid: false } })
    ).toBeUndefined();
  });

  it("refuses a cursor that is not a strict greater-than on a Date", () => {
    expect(
      matchSinceWindow({
        ...windowArgs,
        where: { ...windowArgs.where, createdAt: { gte: new Date() } },
      })
    ).toBeUndefined();
    expect(
      matchSinceWindow({
        ...windowArgs,
        where: { ...windowArgs.where, createdAt: { gt: "2026-08-24T00:00:00Z" } },
      })
    ).toBeUndefined();
  });

  it("refuses a missing take", () => {
    const { take: _dropped, ...withoutTake } = windowArgs;
    expect(matchSinceWindow(withoutTake)).toBeUndefined();
  });

  it("refuses an unknown where key", () => {
    expect(
      matchSinceWindow({ ...windowArgs, where: { ...windowArgs.where, batchId: "batch_1" } })
    ).toBeUndefined();
  });

  it("refuses an unknown top-level key", () => {
    expect(matchSinceWindow({ ...windowArgs, skip: 10 })).toBeUndefined();
  });
});
