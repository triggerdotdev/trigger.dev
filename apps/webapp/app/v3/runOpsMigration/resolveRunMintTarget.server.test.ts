import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRunMintTarget } from "./resolveRunMintTarget.server";
import {
  batchStoreEnabled,
  createRootResidencyDecision,
  idempotencyStoreEnabled,
  rootResidency,
} from "./resolveRootResidency.server";
import { memoryDbStoreRegistered } from "~/v3/runStore.server";
import { logger } from "~/services/logger.server";
import type { FeatureFlagCatalog } from "~/v3/featureFlags";

// Importing the decision module must not build the run store singleton.
vi.mock("~/v3/runStore.server", () => ({ memoryDbStoreRegistered: vi.fn(() => false) }));
const globals = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
vi.mock("~/v3/globalFlagsRegistry.server", () => ({
  globalFlagsRegistry: { current: () => globals.value },
}));

const environment = { organizationId: "org_1", id: "env_1", orgFeatureFlags: {} };
const GEN2_PARENT = `run_${"a".repeat(24)}a2`;
const LEGACY_PARENT = `run_${"b".repeat(25)}`;

describe("resolveRunMintTarget — root", () => {
  it("resolves the kind, then the shard, and returns both", async () => {
    const resolveRunIdMintKind = vi.fn().mockResolvedValue("runOpsId");
    const resolveMintShard = vi.fn().mockResolvedValue("a");

    const target = await resolveRunMintTarget({
      environment,
      deps: { resolveRunIdMintKind, resolveMintShard },
    });

    expect(target).toEqual({ kind: "runOpsId", shardChar: "a", region: undefined });
    expect(resolveMintShard).toHaveBeenCalledWith({ id: "env_1", orgFeatureFlags: {} });
  });

  it("a 'new' shard result carries NO shard char, so the mint stays gen-1", async () => {
    const target = await resolveRunMintTarget({
      environment,
      region: "us-east-1",
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("runOpsId"),
        resolveMintShard: vi.fn().mockResolvedValue("new"),
      },
    });
    expect(target).toEqual({ kind: "runOpsId", region: "us-east-1" });
  });

  it("never resolves a shard when the kind is cuid", async () => {
    const resolveMintShard = vi.fn();
    const target = await resolveRunMintTarget({
      environment,
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("cuid"),
        resolveMintShard,
      },
    });
    expect(target).toEqual({ kind: "cuid" });
    expect(resolveMintShard).not.toHaveBeenCalled();
  });
});

describe("resolveRunMintTarget — child", () => {
  it("inherits a gen-2 parent's shard and consults NEITHER resolver", async () => {
    const resolveRunIdMintKind = vi.fn();
    const resolveMintShard = vi.fn();

    const target = await resolveRunMintTarget({
      environment,
      parentRunFriendlyId: GEN2_PARENT,
      deps: { resolveRunIdMintKind, resolveMintShard },
    });

    expect(target).toEqual({ kind: "runOpsId", shardChar: "a" });
    expect(resolveRunIdMintKind).not.toHaveBeenCalled();
    expect(resolveMintShard).not.toHaveBeenCalled();
  });

  it("a cuid parent still yields cuid though the flag now says runOpsId", async () => {
    const target = await resolveRunMintTarget({
      environment,
      parentRunFriendlyId: LEGACY_PARENT,
      deps: {
        resolveRunIdMintKind: vi.fn().mockResolvedValue("runOpsId"),
        resolveMintShard: vi.fn().mockResolvedValue("a"),
      },
    });
    expect(target).toEqual({ kind: "cuid" });
  });
});

describe("createRootResidencyDecision", () => {
  type Deps = Parameters<typeof createRootResidencyDecision>[0];
  type Groups = ReturnType<Deps["readUnsupportedGroups"]>;
  const SIMPLE = { keyed: false, token: false, delayed: false, debounced: false };
  const KEYED = { ...SIMPLE, keyed: true };
  const TOKEN = { ...SIMPLE, token: true };
  const DELAYED = { ...SIMPLE, delayed: true };
  const DEBOUNCED = { ...SIMPLE, debounced: true };
  const DELAYED_DEBOUNCED = { ...SIMPLE, delayed: true, debounced: true };
  const KEYED_DELAYED = { ...SIMPLE, keyed: true, delayed: true };
  const ALL: Groups = [
    "parentAndChild",
    "batchMembership",
    "idempotencyKeyFields",
    "delayAndRescheduling",
    "debounce",
  ];
  const ORG = {};

  // Every input defaults to admitting; the flags are global values, so each flag read is counted.
  function make(
    o: {
      registered?: boolean;
      allowed?: boolean;
      groups?: Groups;
      idempotency?: boolean;
      batches?: boolean;
    } = {}
  ) {
    const deps = {
      memoryDbStoreRegistered: vi.fn(() => o.registered ?? true),
      isResidencyAllowed: vi.fn(async (_flags?: unknown) => o.allowed ?? true),
      readUnsupportedGroups: vi.fn((): Groups => ("groups" in o ? o.groups : [])),
      readGlobalFlags: vi.fn(
        () =>
          ({
            idempotencyStoreEnabled: o.idempotency ?? true,
            batchStoreEnabled: o.batches ?? true,
          }) as Partial<FeatureFlagCatalog>
      ),
    } satisfies Deps;
    return { deps, decision: createRootResidencyDecision(deps) };
  }
  const v2 = (token = false, keyed = false) => ({
    endpoint: "v2" as const,
    token,
    itemKeyed: vi.fn(() => keyed),
  });

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn");
  });
  afterEach(() => {
    warn.mockRestore();
  });

  describe("without a throw", () => {
    // Catches: a warning logged on a plain admit or refusal.
    afterEach(() => {
      expect(warn).not.toHaveBeenCalled();
    });

    // Catches: a row that also needs a group of another row.
    it.each([
      ["keyed", KEYED, ["idempotencyKeyFields"]],
      ["token", TOKEN, ["idempotencyKeyFields"]],
      ["delayed", DELAYED, ["delayAndRescheduling"]],
      ["debounced", DEBOUNCED, ["debounce", "delayAndRescheduling"]],
      ["delayed and debounced", DELAYED_DEBOUNCED, ["delayAndRescheduling", "debounce"]],
      ["keyed and delayed", KEYED_DELAYED, ["idempotencyKeyFields", "delayAndRescheduling"]],
    ])("admits a %s root with every other group unsupported", async (_name, kind, own) => {
      const groups = ALL!.filter((group) => !own.includes(group));
      expect(await make({ groups }).decision.allowsRootRun(ORG, kind)).toBe(true);
    });

    // Catches: a row that refuses a root whose flag and groups are all on.
    it.each([
      ["simple", SIMPLE],
      ["keyed", KEYED],
      ["token", TOKEN],
      ["delayed", DELAYED],
      ["debounced", DEBOUNCED],
      ["delayed and debounced", DELAYED_DEBOUNCED],
      ["keyed and delayed", KEYED_DELAYED],
    ])("admits a %s root with its flag on and the list empty", async (_name, kind) => {
      expect(await make().decision.allowsRootRun(ORG, kind)).toBe(true);
    });

    // Catches: a row that ignores its flag or one of its groups, or a several-kind root that needs only one row.
    it.each([
      ["keyed", KEYED, { idempotency: false }],
      ["keyed", KEYED, { groups: ["idempotencyKeyFields"] as Groups }],
      ["token", TOKEN, { idempotency: false }],
      ["token", TOKEN, { groups: ["idempotencyKeyFields"] as Groups }],
      ["delayed", DELAYED, { groups: ["delayAndRescheduling"] as Groups }],
      ["debounced", DEBOUNCED, { groups: ["debounce"] as Groups }],
      ["debounced", DEBOUNCED, { groups: ["delayAndRescheduling"] as Groups }],
      ["delayed and debounced", DELAYED_DEBOUNCED, { groups: ["debounce"] as Groups }],
      ["delayed and debounced", DELAYED_DEBOUNCED, { groups: ["delayAndRescheduling"] as Groups }],
      ["keyed and delayed", KEYED_DELAYED, { groups: ["delayAndRescheduling"] as Groups }],
      ["keyed and delayed", KEYED_DELAYED, { idempotency: false }],
    ])("refuses a %s root with %o", async (_name, kind, o) => {
      expect(await make(o).decision.allowsRootRun(ORG, kind)).toBe(false);
    });

    // Catches: an unpublished list read as an empty one.
    it("with the list unpublished, admits only the simple root", async () => {
      const { decision } = make({ groups: undefined });
      expect(await decision.allowsRootRun(ORG, SIMPLE)).toBe(true);
      for (const kind of [KEYED, TOKEN, DELAYED, DEBOUNCED, DELAYED_DEBOUNCED]) {
        expect(await decision.allowsRootRun(ORG, kind)).toBe(false);
      }
      expect(await decision.allowsRootBatch(ORG, v2())).toBe(false);
      expect(await decision.allowsRootBatch(ORG, { endpoint: "streaming" })).toBe(false);
    });

    // Catches: a simple root made to depend on a flag or a group.
    it("a simple root reads no group and no flag", async () => {
      const { deps, decision } = make({ groups: undefined, idempotency: false });
      expect(await decision.allowsRootRun(ORG, SIMPLE)).toBe(true);
      expect(deps.readUnsupportedGroups).not.toHaveBeenCalled();
      expect(deps.readGlobalFlags).not.toHaveBeenCalled();
    });

    // Catches: a read of any kind with no flags in hand.
    it("no flags in hand gives false with nothing called", async () => {
      const { deps, decision } = make();
      expect(await decision.allowsRootRun(undefined, SIMPLE)).toBe(false);
      const batch = v2();
      expect(await decision.allowsRootBatch(undefined, batch)).toBe(false);
      for (const dep of [...Object.values(deps), batch.itemKeyed]) {
        expect(dep).not.toHaveBeenCalled();
      }
    });

    // Catches: the rule asked in a process with no store under the MemoryDB key.
    it("no store under the MemoryDB key gives false with the rule not called", async () => {
      const { deps, decision } = make({ registered: false });
      expect(await decision.allowsRootRun(ORG, SIMPLE)).toBe(false);
      expect(await decision.allowsRootBatch(ORG, { endpoint: "streaming" })).toBe(false);
      expect(deps.isResidencyAllowed).not.toHaveBeenCalled();
    });

    // Catches: admission read before the rule, or the rule's answer ignored.
    it("the rule false gives false with no group, flag or item read", async () => {
      const { deps, decision } = make({ allowed: false });
      expect(await decision.allowsRootRun(ORG, KEYED_DELAYED)).toBe(false);
      const batch = v2();
      expect(await decision.allowsRootBatch(ORG, batch)).toBe(false);
      expect(deps.isResidencyAllowed).toHaveBeenCalledWith(ORG);
      expect(deps.readUnsupportedGroups).not.toHaveBeenCalled();
      expect(deps.readGlobalFlags).not.toHaveBeenCalled();
      expect(batch.itemKeyed).not.toHaveBeenCalled();
    });

    // Catches: a batch row that drops the batches flag, a group, or the idempotency condition.
    it.each([
      ["v2", () => v2(), {}, true],
      ["v2 with a token", () => v2(true), {}, true],
      ["v2 with an item key", () => v2(false, true), {}, true],
      ["v2", () => v2(), { idempotency: false }, true],
      ["v2 with a token", () => v2(true), { idempotency: false }, false],
      ["v2 with an item key", () => v2(false, true), { idempotency: false }, false],
      ["v2", () => v2(), { batches: false }, false],
      ["streaming", () => ({ endpoint: "streaming" as const }), {}, true],
      ["streaming", () => ({ endpoint: "streaming" as const }), { idempotency: false }, false],
      ["streaming", () => ({ endpoint: "streaming" as const }), { batches: false }, false],
      ...ALL!.flatMap((group) => [
        ["v2", () => v2(), { groups: [group] as Groups }, false] as const,
        [
          "streaming",
          () => ({ endpoint: "streaming" as const }),
          { groups: [group] },
          false,
        ] as const,
      ]),
    ])("a %s root batch with %o is admitted: %s", async (_name, batch, o, admitted) => {
      expect(await make(o).decision.allowsRootBatch(ORG, batch())).toBe(admitted);
    });

    // Catches: a request's items iterated when the answer does not depend on them.
    it("asks itemKeyed only for v2 with the idempotency flag off and no token", async () => {
      const cases: Array<[Parameters<typeof make>[0], boolean, number]> = [
        [{}, false, 0],
        [{ idempotency: false }, true, 0],
        [{ idempotency: false, batches: false }, false, 0],
        [{ idempotency: false, groups: ["debounce"] }, false, 0],
        [{ idempotency: false }, false, 1],
      ];
      for (const [o, token, calls] of cases) {
        const batch = v2(token);
        await make(o).decision.allowsRootBatch(ORG, batch);
        expect(batch.itemKeyed).toHaveBeenCalledTimes(calls);
      }
    });
  });

  // Catches: a throw that escapes the decision, gives true, or warns other than once with its message.
  it.each([
    [
      "the rule",
      (d: Deps) => (d.isResidencyAllowed = () => Promise.reject(new Error("rule"))),
      "rule",
    ],
    [
      "the group reader",
      (d: Deps) =>
        (d.readUnsupportedGroups = () => {
          throw new Error("groups");
        }),
      "groups",
    ],
    [
      "the registry",
      (d: Deps) =>
        (d.memoryDbStoreRegistered = () => {
          throw new Error("registry");
        }),
      "registry",
    ],
    [
      "a flag read",
      (d: Deps) =>
        (d.readGlobalFlags = () => {
          throw new Error("flags");
        }),
      "flags",
    ],
  ])("a throw from %s gives false and one warning", async (_name, breakDep, message) => {
    const { deps } = make();
    breakDep(deps);
    const decision = createRootResidencyDecision(deps);
    expect(await decision.allowsRootRun(ORG, KEYED_DELAYED)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("runResidency.root_decision_failed", { error: message });
  });

  it("a throw from itemKeyed gives false and one warning", async () => {
    const itemKeyed = vi.fn(() => {
      throw "items";
    });
    expect(
      await make({ idempotency: false }).decision.allowsRootBatch(ORG, {
        endpoint: "v2",
        token: false,
        itemKeyed,
      })
    ).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("runResidency.root_decision_failed", { error: "items" });
  });

  // Catches: the production instance not asking the run store whether a store is registered under m.
  it("the production instance gives false with no store under m, before the rule", async () => {
    const registered = vi.mocked(memoryDbStoreRegistered);
    registered.mockClear();
    const enrolled = {
      runResidencyEnabled: true,
      waitpointStoreEnabled: true,
      activeRunStoreEnabled: true,
      checkpointStoreEnabled: true,
      clickhouseFeedEnabled: true,
      realtimeNativeOnly: true,
      idempotencyStoreEnabled: true,
      batchStoreEnabled: true,
    };
    expect(await rootResidency.allowsRootRun(enrolled, SIMPLE)).toBe(false);
    expect(await rootResidency.allowsRootBatch(enrolled, { endpoint: "streaming" })).toBe(false);
    expect(registered).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  // Catches: the production flag functions reading the wrong key or order, or accepting a string.
  it("the production flag functions read the override, then the global value, then false", () => {
    for (const [read, key] of [
      [idempotencyStoreEnabled, "idempotencyStoreEnabled"],
      [batchStoreEnabled, "batchStoreEnabled"],
    ] as const) {
      globals.value = undefined;
      expect(read({})).toBe(false);
      expect(read({ [key]: true })).toBe(true);
      globals.value = { [key]: true };
      expect(read({})).toBe(true);
      expect(read({ [key]: false })).toBe(false);
      expect(read({ [key]: "false" })).toBe(true);
      globals.value = { [key]: false };
      expect(read({ [key]: "true" })).toBe(false);
    }
    globals.value = undefined;
  });
});
