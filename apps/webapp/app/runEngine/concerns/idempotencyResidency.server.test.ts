import { describe, expect, it } from "vitest";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import {
  clientForShardKey,
  resolveIdempotencyDedupClient,
  type ResolveIdempotencyClientDeps,
} from "./idempotencyResidency.server";

// Distinct sentinel objects so we can assert WHICH client was selected by reference.
const FALLBACK = { __tag: "fallback" } as never;
const NEW_CLIENT = { __tag: "new" } as never;
const LEGACY_CLIENT = { __tag: "legacy" } as never;
const SHARD_A_CLIENT = { __tag: "shard-a" } as never;

function clientMap() {
  return new Map([
    ["new", NEW_CLIENT],
    ["legacy", LEGACY_CLIENT],
    ["a", SHARD_A_CLIENT],
  ]);
}

function makeDeps(over: Partial<ResolveIdempotencyClientDeps>): ResolveIdempotencyClientDeps {
  return {
    isSplitEnabled: async () => true,
    fallbackClient: FALLBACK,
    clientFor: (key) => clientMap().get(key),
    resolveMintKind: async () => "runOpsId",
    // Kept as an injected seam: the real resolveShard is total, so only an injected
    // classifier can exercise the throw-to-fallback arm below.
    classify: (id) => {
      if (id.length === 26 && id[25] === "2") return id[24]!;
      if (id.length === 26 && id[25] === "1") return "new";
      if (id.length === 25) return "legacy";
      throw new Error(`unclassifiable: ${id.length}`);
    },
    ...over,
  };
}

const env = { organizationId: "org_1", id: "env_1", orgFeatureFlags: {} };

describe("resolveIdempotencyDedupClient", () => {
  it("returns the fallback client unchanged when split is disabled", async () => {
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: undefined },
      makeDeps({ isSplitEnabled: async () => false })
    );
    expect(client).toBe(FALLBACK);
  });

  it("routes a root run to the NEW client when the env mints run-ops ids", async () => {
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: undefined },
      makeDeps({ resolveMintKind: async () => "runOpsId" })
    );
    expect(client).toBe(NEW_CLIENT);
  });

  it("routes a root run to the LEGACY client when the env mints cuid", async () => {
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: undefined },
      makeDeps({ resolveMintKind: async () => "cuid" })
    );
    expect(client).toBe(LEGACY_CLIENT);
  });

  it("routes a child to the NEW client when the run-ops parent is NEW-resident", async () => {
    const runOpsParent = RunId.toFriendlyId("a".repeat(24) + "01");
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: runOpsParent },
      makeDeps({ resolveMintKind: async () => "cuid" }) // mint flag must NOT win for a child
    );
    expect(client).toBe(NEW_CLIENT);
  });

  it("routes a child to the LEGACY client when the cuid parent is LEGACY-resident", async () => {
    const cuidParent = RunId.toFriendlyId("b".repeat(25));
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: cuidParent },
      makeDeps({ resolveMintKind: async () => "runOpsId" }) // mint flag must NOT win for a child
    );
    expect(client).toBe(LEGACY_CLIENT);
  });

  it("falls back to the fallback client when a present parent id is unclassifiable", async () => {
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: "run_not-a-valid-length" },
      makeDeps({})
    );
    expect(client).toBe(FALLBACK);
  });

  it("routes a child to its OWN SHARD client when the parent is a gen-2 id", async () => {
    const genTwoParent = RunId.toFriendlyId("e".repeat(24) + "a2");
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: genTwoParent },
      makeDeps({ resolveMintKind: async () => "cuid" }) // mint flag must NOT win for a child
    );
    expect(client).toBe(SHARD_A_CLIENT);
  });

  it("falls back and logs when a gen-2 parent names an unconfigured shard key", async () => {
    const errors: unknown[] = [];
    const genTwoParent = RunId.toFriendlyId("f".repeat(24) + "z2");
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: genTwoParent },
      makeDeps({ logger: { error: (_m, meta) => errors.push(meta) } })
    );
    expect(client).toBe(FALLBACK);
    expect(errors).toHaveLength(1);
  });
});

describe("clientForShardKey", () => {
  it("selects the same client the map holds for each reserved key and shard key", () => {
    const clients = clientMap();
    const clientFor = (key: string) => clients.get(key);
    expect(clientForShardKey("new", clientFor, FALLBACK)).toBe(NEW_CLIENT);
    expect(clientForShardKey("legacy", clientFor, FALLBACK)).toBe(LEGACY_CLIENT);
    expect(clientForShardKey("a", clientFor, FALLBACK)).toBe(SHARD_A_CLIENT);
  });

  it("returns the fallback and logs for a key the map does not hold", () => {
    const errors: unknown[] = [];
    const map = clientMap();
    const client = clientForShardKey("z", (key) => map.get(key), FALLBACK, {
      error: (_m, meta) => errors.push(meta),
    });
    expect(client).toBe(FALLBACK);
    expect(errors).toHaveLength(1);
  });
});
