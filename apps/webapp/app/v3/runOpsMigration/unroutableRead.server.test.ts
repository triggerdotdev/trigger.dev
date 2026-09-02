import { UnknownShardKey } from "@internal/run-store";
import { describe, expect, it } from "vitest";
import { undefinedOnUnroutableId } from "./unroutableRead.server";

// `RoutingRunStore.findRun` is not async: it resolves the shard and throws before returning
// anything, so these stand in for a read that fails while the call expression is still being
// evaluated rather than one that returns a rejected promise.
function throwsWhileRouting(): Promise<string | null> {
  throw new UnknownShardKey("q", ["legacy", "new"]);
}

function rejectsLater(): Promise<string | null> {
  return Promise.reject(new UnknownShardKey("q", ["legacy", "new"]));
}

describe("undefinedOnUnroutableId", () => {
  it("returns undefined when the read throws synchronously while routing", async () => {
    await expect(
      undefinedOnUnroutableId(() => throwsWhileRouting(), { runParam: "run_x" })
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the read rejects", async () => {
    await expect(
      undefinedOnUnroutableId(() => rejectsLater(), { runParam: "run_x" })
    ).resolves.toBeUndefined();
  });

  it("passes a successful read through untouched", async () => {
    await expect(undefinedOnUnroutableId(async () => "found", { runParam: "run_x" })).resolves.toBe(
      "found"
    );
  });

  it("rethrows anything that is not an unroutable id", async () => {
    const boom = new Error("connection refused");

    await expect(
      undefinedOnUnroutableId(
        () => {
          throw boom;
        },
        { runParam: "run_x" }
      )
    ).rejects.toBe(boom);
  });
});
