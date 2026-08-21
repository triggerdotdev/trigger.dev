// Unit suite for the raw Redis execution-snapshot store. Redis-only: the store holds no Prisma
// reference, so no Postgres container is needed.
import { expect, describe } from "vitest";
import { snapshotKeys, deriveOrder, isValidFor } from "./redisSnapshotStore.js";

describe("snapshotKeys", () => {
  it("puts every core key under one hash tag", () => {
    const k = snapshotKeys("run_abc123");
    expect(k.e).toBe("snap:{run_abc123}:e");
    expect(k.idx).toBe("snap:{run_abc123}:idx");
    expect(k.cur).toBe("snap:{run_abc123}:cur");
    expect(k.seq).toBe("snap:{run_abc123}:seq");
  });
});

describe("deriveOrder", () => {
  it("drops entries with no index, sorts by index, and maps to id", () => {
    expect(
      deriveOrder([
        { id: "w_c", index: 2 },
        { id: "w_a", index: 0 },
        { id: "w_no" },
        { id: "w_b", index: 1 },
      ])
    ).toEqual(["w_a", "w_b", "w_c"]);
  });

  it("preserves a repeated id at each of its positions", () => {
    expect(
      deriveOrder([
        { id: "w_x", index: 0 },
        { id: "w_x", index: 1 },
      ])
    ).toEqual(["w_x", "w_x"]);
  });

  it("returns an empty list when nothing carries an index", () => {
    expect(deriveOrder([{ id: "w_a" }, { id: "w_b" }])).toEqual([]);
  });
});

describe("isValidFor", () => {
  it("is false when the entry carries an error and true otherwise", () => {
    expect(isValidFor({ error: "boom" })).toBe(false);
    expect(isValidFor({})).toBe(true);
    expect(isValidFor({ error: undefined })).toBe(true);
  });
});
