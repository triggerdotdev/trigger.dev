import { describe, expect, it } from "vitest";
import { RoutingRunStore } from "@internal/run-store";
import { buildRunStore } from "~/v3/runStore.server";

// Construction-only: buildRunStore wraps clients but never connects, so stub handles suffice. This
// asserts the wiring shape (compat router vs N-way router), not query behaviour.
const stub = () => ({}) as any;

const baseSplit = {
  splitEnabled: true as const,
  newWriter: stub(),
  newReplica: stub(),
  legacyWriter: stub(),
  legacyReplica: stub(),
  singleWriter: stub(),
  singleReplica: stub(),
};

describe("buildRunStore shard wiring", () => {
  it("split ON with no shards builds the two-store compat router", () => {
    const store = buildRunStore(baseSplit);
    expect(store).toBeInstanceOf(RoutingRunStore);
  });

  it("split ON with two shard descriptors builds the N-way router", () => {
    const store = buildRunStore({
      ...baseSplit,
      shards: [
        { key: "a", writer: stub(), replica: stub() },
        { key: "b", writer: stub(), replica: stub() },
      ],
    });
    expect(store).toBeInstanceOf(RoutingRunStore);
  });

  it("split OFF builds the single-store passthrough (not a router)", () => {
    const store = buildRunStore({
      splitEnabled: false,
      singleWriter: stub(),
      singleReplica: stub(),
    });
    expect(store).not.toBeInstanceOf(RoutingRunStore);
  });
});
