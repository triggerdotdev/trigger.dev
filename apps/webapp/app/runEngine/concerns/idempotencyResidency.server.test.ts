import { describe, expect, it } from "vitest";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import {
  resolveIdempotencyDedupClient,
  type ResolveIdempotencyClientDeps,
} from "./idempotencyResidency.server";

// Distinct sentinel objects so we can assert WHICH client was selected by reference.
const FALLBACK = { __tag: "fallback" } as never;
const NEW_CLIENT = { __tag: "new" } as never;
const LEGACY_CLIENT = { __tag: "legacy" } as never;

function makeDeps(over: Partial<ResolveIdempotencyClientDeps>): ResolveIdempotencyClientDeps {
  return {
    isSplitEnabled: async () => true,
    fallbackClient: FALLBACK,
    newClient: NEW_CLIENT,
    legacyClient: LEGACY_CLIENT,
    resolveMintKind: async () => "runOpsId",
    classify: (id) => {
      if (id.length === 26 && id[25] === "1") return "NEW";
      if (id.length === 25) return "LEGACY";
      throw new Error(`unclassifiable: ${id.length}`);
    },
    isMigrated: undefined,
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

  it("routes a swept (migrated) cuid-parent child to the NEW client", async () => {
    const cuidParent = RunId.toFriendlyId("c".repeat(25));
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: cuidParent },
      makeDeps({ isMigrated: async () => true })
    );
    expect(client).toBe(NEW_CLIENT);
  });

  it("routes a non-migrated cuid-parent child to the LEGACY client even when isMigrated is provided", async () => {
    const cuidParent = RunId.toFriendlyId("d".repeat(25));
    const client = await resolveIdempotencyDedupClient(
      { environmentForMint: env, parentRunFriendlyId: cuidParent },
      makeDeps({ isMigrated: async () => false })
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
});
