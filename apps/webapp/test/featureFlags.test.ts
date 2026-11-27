// flag() resolves a per-org override without paying for the global row: a valid override
// short-circuits the query, an invalid one still falls through to the global value.
// NEVER mocks the DB: real testcontainers Postgres FeatureFlag rows, with the findFirst
// call counted by a delegating wrapper around the real client.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import type * as DbServerModule from "~/db.server";
import type { PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createReloadingRegistry } from "~/utils/reloadingRegistry.server";
import {
  FEATURE_FLAG,
  FeatureFlagCatalog,
  GLOBAL_LOCKED_FLAGS,
  GRACED_FLAG_GROUPS,
  hasUnreadableTurnEvalsOverride,
  ORG_LOCKED_FLAG_EFFECT,
  ORG_LOCKED_FLAGS,
  parseStoredOrgFlags,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";
import { flags, makeFlag, makeSetFlag } from "~/v3/featureFlags.server";
import {
  createRunResidencyAllowedResolver,
  createRunResidencyEnabledResolver,
  createRunResidencyHasBeenOnResolver,
} from "~/v3/utils/runResidency.server";
import { createRunResidencyGate } from "~/v3/utils/runResidencyGate.server";
import { splitRunStoreDeps } from "~/v3/runStore.server";
import { organizationContext, type OrganizationContext } from "@internal/run-store";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

// `flags` is built on the app's default client: forward it to the current test's database.
vi.mock("~/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof DbServerModule>();
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        const value = (db.client as any)[prop];
        return typeof value === "function" ? value.bind(db.client) : value;
      },
    }
  );
  // The control-plane resolver reads the replica when split mode is on: forward it too.
  return { ...actual, prisma: client, $replica: client };
});

const KEY = FEATURE_FLAG.dashboardAgentTurnEvalsEnabled;

function countingClient(prisma: PrismaClient) {
  const calls = { findFirst: 0 };
  const client = {
    featureFlag: {
      findFirst: (args: unknown) => {
        calls.findFirst++;
        return (prisma.featureFlag.findFirst as (a: unknown) => unknown)(args);
      },
    },
  } as unknown as PrismaClientOrTransaction;

  return { client, calls };
}

describe("flag() override resolution", () => {
  postgresTest(
    "a valid `false` override wins without querying the global row",
    async ({ prisma }) => {
      await makeSetFlag(prisma)({ key: KEY, value: true });
      const { client, calls } = countingClient(prisma);

      const result = await makeFlag(client)({
        key: KEY,
        defaultValue: true,
        overrides: { [KEY]: false },
      });

      expect(result).toBe(false);
      expect(calls.findFirst).toBe(0);
    }
  );

  postgresTest(
    "a valid `true` override wins without querying the global row",
    async ({ prisma }) => {
      await makeSetFlag(prisma)({ key: KEY, value: false });
      const { client, calls } = countingClient(prisma);

      const result = await makeFlag(client)({
        key: KEY,
        defaultValue: false,
        overrides: { [KEY]: true },
      });

      expect(result).toBe(true);
      expect(calls.findFirst).toBe(0);
    }
  );

  postgresTest(
    "an override that fails the schema falls through to the global value",
    async ({ prisma }) => {
      await makeSetFlag(prisma)({ key: KEY, value: true });
      const { client, calls } = countingClient(prisma);

      const result = await makeFlag(client)({
        key: KEY,
        defaultValue: false,
        overrides: { [KEY]: "yes please" },
      });

      expect(result).toBe(true);
      expect(calls.findFirst).toBe(1);
    }
  );

  postgresTest("no override still queries the global row", async ({ prisma }) => {
    await makeSetFlag(prisma)({ key: KEY, value: true });
    const { client, calls } = countingClient(prisma);

    const result = await makeFlag(client)({
      key: KEY,
      defaultValue: false,
      overrides: {},
    });

    expect(result).toBe(true);
    expect(calls.findFirst).toBe(1);
  });
});

describe("flags()", () => {
  // Catches: flags() returning a stored key outside the catalogue, or a value its schema rejects.
  postgresTest("returns only catalogue keys whose stored value parses", async ({ prisma }) => {
    db.client = prisma;
    await prisma.featureFlag.createMany({
      data: [
        { key: FEATURE_FLAG.waitpointStoreEnabled, value: true },
        { key: "notInTheCatalogue", value: true },
        { key: FEATURE_FLAG.realtimeBackend, value: "not-a-backend" },
      ],
    });

    expect(await flags()).toEqual({ [FEATURE_FLAG.waitpointStoreEnabled]: true });
  });
});

// The fall-through above is right for an entitlement and wrong for consent: judging sends the
// turn to a third-party model, so the eval flag refuses on an override it cannot read.
describe("hasUnreadableTurnEvalsOverride", () => {
  it("is false when the org has no opinion", () => {
    expect(hasUnreadableTurnEvalsOverride({})).toBe(false);
    expect(hasUnreadableTurnEvalsOverride(null)).toBe(false);
    expect(hasUnreadableTurnEvalsOverride([])).toBe(false);
    expect(hasUnreadableTurnEvalsOverride({ somethingElse: "nonsense" })).toBe(false);
  });

  it("is false for a real boolean, either way", () => {
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: false })).toBe(false);
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: true })).toBe(false);
  });

  // The dangerous one: `flag()` would drop "false" and hand back the global default, which is on.
  it("is true for a stringified boolean or any other garbage", () => {
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: "false" })).toBe(true);
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: "true" })).toBe(true);
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: 0 })).toBe(true);
    expect(hasUnreadableTurnEvalsOverride({ [KEY]: null })).toBe(true);
  });
});

describe("deployNowEnabled flag", () => {
  it("is registered as a strict boolean flag", () => {
    expect(FEATURE_FLAG.deployNowEnabled).toBe("deployNowEnabled");
    const schema = FeatureFlagCatalog[FEATURE_FLAG.deployNowEnabled];
    expect(schema.safeParse(true).success).toBe(true);
    // strict boolean: the string "false" must NOT coerce to a boolean
    expect(schema.safeParse("false").success).toBe(false);
  });
});

describe("runResidencyEnabled flag", () => {
  // Catches: a coercing schema, which reads the string "false" as on and enrols the wrong orgs.
  it("is registered as a strict boolean flag", () => {
    expect(FEATURE_FLAG.runResidencyEnabled).toBe("runResidencyEnabled");
    const schema = FeatureFlagCatalog[FEATURE_FLAG.runResidencyEnabled];
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(false).success).toBe(true);
    for (const value of ["true", "false", 1, null]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
    const partial = validatePartialFeatureFlags({ runResidencyEnabled: true });
    expect(partial.success && partial.data).toEqual({ runResidencyEnabled: true });
  });

  // Catches: a coercing stamp schema, an editable stamp, or the switch missing from the grace table.
  it("registers the switch's grace stamps as locked, derived keys of a keep-on group", () => {
    const prev = FeatureFlagCatalog[FEATURE_FLAG.runResidencyEnabledPrev];
    expect(prev.safeParse(true).success).toBe(true);
    expect(prev.safeParse(false).success).toBe(true);
    for (const value of ["true", 1, null]) {
      expect(prev.safeParse(value).success).toBe(false);
    }
    const flippedAt = FeatureFlagCatalog[FEATURE_FLAG.runResidencyEnabledFlippedAt];
    expect(flippedAt.safeParse("2026-01-01T00:00:00.000Z").success).toBe(true);
    expect(flippedAt.safeParse("yesterday").success).toBe(false);

    for (const key of [
      FEATURE_FLAG.runResidencyEnabledPrev,
      FEATURE_FLAG.runResidencyEnabledFlippedAt,
    ]) {
      expect(GLOBAL_LOCKED_FLAGS).toContain(key);
      expect(ORG_LOCKED_FLAGS).toContain(key);
      expect(ORG_LOCKED_FLAG_EFFECT[key]).toBe("derived");
    }
    expect(GRACED_FLAG_GROUPS.find((g) => g.primary === FEATURE_FLAG.runResidencyEnabled)).toEqual({
      primary: FEATURE_FLAG.runResidencyEnabled,
      derived: [FEATURE_FLAG.runResidencyEnabledPrev, FEATURE_FLAG.runResidencyEnabledFlippedAt],
      booleanRule: "keepOn",
    });
  });
});

const HOUR_MS = 60 * 60 * 1000;

type RuleDeps = Parameters<typeof createRunResidencyAllowedResolver>[0];

const ENROLLED_ENV: RuleDeps["env"] = {
  RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL: "redis://127.0.0.1:7101",
  RUN_ENGINE_WAITPOINT_STORE_REDIS_URL: "redis://127.0.0.1:7101",
  REALTIME_BACKEND_NATIVE_ENABLED: "1",
  REALTIME_BACKEND_DEFAULT: "electric",
  TRIGGER_MOLLIFIER_ENABLED: "1",
};

const ENROLLED_FLAGS: Record<string, unknown> = {
  runResidencyEnabled: true,
  waitpointStoreEnabled: true,
  activeRunStoreEnabled: true,
  checkpointStoreEnabled: true,
  clickhouseFeedEnabled: true,
  realtimeBackend: "native",
  mollifierEnabled: false,
};

/** The enrolled flags with some keys changed; a key set to `undefined` is removed. */
function enrolledFlags(changes: Record<string, unknown> = {}) {
  const flags = { ...ENROLLED_FLAGS, ...changes };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete flags[key];
  }
  return flags;
}

/** The rule over the enrolled dependencies with some changed, counting each reader's calls. */
function enrolledRule({
  env = {},
  isSplitEnabled = async () => true,
  readGlobalFlags = () => ({}),
  graceMs = HOUR_MS,
}: {
  env?: Partial<RuleDeps["env"]>;
  isSplitEnabled?: RuleDeps["isSplitEnabled"];
  readGlobalFlags?: RuleDeps["readGlobalFlags"];
  graceMs?: number;
} = {}) {
  const calls = { readGlobalFlags: 0, isSplitEnabled: 0 };
  const rule = createRunResidencyAllowedResolver({
    env: { ...ENROLLED_ENV, ...env },
    isSplitEnabled: () => {
      calls.isSplitEnabled++;
      return isSplitEnabled();
    },
    readGlobalFlags: () => {
      calls.readGlobalFlags++;
      return readGlobalFlags();
    },
    graceMs,
  });
  return { rule, calls };
}

function globals(values: Record<string, unknown>) {
  return () => values as Partial<FeatureFlagCatalog>;
}

describe("createRunResidencyEnabledResolver", () => {
  // Catches: the switch reading global before override, coercing a string, or treating null as no flags.
  it.each([
    ["override true, global false", { runResidencyEnabled: true }, false, true],
    ["override false, global true", { runResidencyEnabled: false }, true, false],
    ["no override, global true", {}, true, true],
    ["no override, global false", {}, false, false],
    ["no override, global undefined", {}, undefined, false],
    ['override "true", global false', { runResidencyEnabled: "true" }, false, false],
    ['override "true", global true', { runResidencyEnabled: "true" }, true, true],
    ["flags in hand null, global true", null, true, true],
  ])("%s", (_name, organizationFlags, global, expected) => {
    const enabled = createRunResidencyEnabledResolver(
      () => (global === undefined ? undefined : { runResidencyEnabled: global }),
      HOUR_MS
    );
    expect(enabled(organizationFlags)).toBe(expected);
  });

  // Catches: the switch not reading the in-memory global flags the registry loads.
  it("reads the global value from a reloading registry once it has loaded", async () => {
    const registry = createReloadingRegistry<Partial<FeatureFlagCatalog>>({
      name: "test-run-residency",
      intervalMs: 10_000,
      autoStart: false,
      load: async () => ({ runResidencyEnabled: true }),
    });
    try {
      const enabled = createRunResidencyEnabledResolver(() => registry.current(), HOUR_MS);
      expect(enabled({})).toBe(false);
      await registry.reload();
      expect(enabled({})).toBe(true);
    } finally {
      registry.stop();
    }
  });

  // Catches: falling through to the global value when the caller has no flags in hand.
  it("is off with no flags in hand, without reading the global flags", () => {
    let reads = 0;
    const enabled = createRunResidencyEnabledResolver(() => {
      reads++;
      return { runResidencyEnabled: true };
    }, HOUR_MS);
    expect(enabled(undefined)).toBe(false);
    expect(reads).toBe(0);
  });

  // Catches: the switch swallowing a failed read, which only the rule may turn into "not allowed".
  it("lets a throwing global-flags reader throw", () => {
    const enabled = createRunResidencyEnabledResolver(() => {
      throw new Error("registry broken");
    }, HOUR_MS);
    expect(() => enabled({})).toThrow("registry broken");
  });

  // Catches: the switch read without its grace, or the global flags read more than once per call.
  it("serves an organisation stamp inside the grace of a change from on to off as on", () => {
    let reads = 0;
    const enabled = createRunResidencyEnabledResolver(() => {
      reads++;
      return {};
    }, HOUR_MS);
    const offFromOn = (flippedAtMs: number) => ({
      runResidencyEnabled: false,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: new Date(flippedAtMs).toISOString(),
    });
    expect(enabled(offFromOn(Date.now()))).toBe(true);
    expect(enabled(offFromOn(Date.now() - 2 * HOUR_MS))).toBe(false);
    expect(reads).toBe(2);
  });
});

describe("createRunResidencyHasBeenOnResolver", () => {
  // Catches: the reader not passing the organisation's stamp through, or reading globals once per key.
  it("is true for an organisation stamp recording on with the switch off, reading once per call", () => {
    let reads = 0;
    const hasBeenOn = createRunResidencyHasBeenOnResolver(() => {
      reads++;
      return {};
    });
    expect(
      hasBeenOn({
        runResidencyEnabled: false,
        runResidencyEnabledPrev: true,
        runResidencyEnabledFlippedAt: "2026-01-01T00:00:00.000Z",
      })
    ).toBe(true);
    expect(hasBeenOn({})).toBe(false);
    expect(reads).toBe(2);
  });

  // Catches: the reader falling through to the global flags with no flags in hand.
  it("is false with no flags in hand, without reading the global flags", () => {
    let reads = 0;
    const hasBeenOn = createRunResidencyHasBeenOnResolver(() => {
      reads++;
      return { runResidencyEnabled: true };
    });
    expect(hasBeenOn(undefined)).toBe(false);
    expect(reads).toBe(0);
  });

  // Catches: the reader swallowing a failed read, which the gate's throw boundary owns.
  it("lets a throwing global-flags reader throw", () => {
    const hasBeenOn = createRunResidencyHasBeenOnResolver(() => {
      throw new Error("registry broken");
    });
    expect(() => hasBeenOn({})).toThrow("registry broken");
  });
});

describe("createRunResidencyAllowedResolver", () => {
  // Catches: the rule failing an enrolled org, or reading a flag outside the rule.
  it("allows the enrolled inputs, whatever the flags outside the rule say", async () => {
    expect(await enrolledRule().rule(enrolledFlags())).toBe(true);
    const outside = {
      archiveStoreEnabled: false,
      outflowEnabled: false,
      idempotencyStoreEnabled: false,
      archiveReadPathEnabled: false,
      batchStoreEnabled: false,
    };
    expect(await enrolledRule().rule(enrolledFlags(outside))).toBe(true);
  });

  // Catches: a condition dropped from the rule, or one read the wrong way.
  it.each<[string, Parameters<typeof enrolledRule>[0], Record<string, unknown>]>([
    ["runResidencyEnabled: false", {}, { runResidencyEnabled: false }],
    ["isSplitEnabled resolving false", { isSplitEnabled: async () => false }, {}],
    [
      "snapshot store URL undefined",
      { env: { RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL: undefined } },
      {},
    ],
    ['snapshot store URL ""', { env: { RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL: "" } }, {}],
    [
      "waitpoint store URL undefined",
      { env: { RUN_ENGINE_WAITPOINT_STORE_REDIS_URL: undefined } },
      {},
    ],
    ['waitpoint store URL ""', { env: { RUN_ENGINE_WAITPOINT_STORE_REDIS_URL: "" } }, {}],
    ["waitpointStoreEnabled: false", {}, { waitpointStoreEnabled: false }],
    ["waitpointStoreEnabled removed", {}, { waitpointStoreEnabled: undefined }],
    ["activeRunStoreEnabled removed", {}, { activeRunStoreEnabled: undefined }],
    ["checkpointStoreEnabled removed", {}, { checkpointStoreEnabled: undefined }],
    ["clickhouseFeedEnabled removed", {}, { clickhouseFeedEnabled: undefined }],
    ['REALTIME_BACKEND_NATIVE_ENABLED "0"', { env: { REALTIME_BACKEND_NATIVE_ENABLED: "0" } }, {}],
    [
      'REALTIME_BACKEND_NATIVE_ENABLED "true"',
      { env: { REALTIME_BACKEND_NATIVE_ENABLED: "true" } },
      {},
    ],
    ['realtimeBackend: "electric"', {}, { realtimeBackend: "electric" }],
    ['realtimeBackend: "shadow"', {}, { realtimeBackend: "shadow" }],
    ["mollifierEnabled: true", {}, { mollifierEnabled: true }],
  ])("refuses with %s", async (_name, deps, flags) => {
    expect(await enrolledRule(deps).rule(enrolledFlags(flags))).toBe(false);
  });

  const realtimeChanges: [string, Parameters<typeof enrolledRule>[0], Record<string, unknown>][] = [
    ["native disabled", { env: { REALTIME_BACKEND_NATIVE_ENABLED: "0" } }, {}],
    ['"electric"', {}, { realtimeBackend: "electric" }],
    ['"shadow"', {}, { realtimeBackend: "shadow" }],
  ];

  // Catches: realtimeNativeOnly read as "and" with the backend, or coerced from a string.
  it.each(
    realtimeChanges.flatMap(([name, deps, flags]) =>
      (
        [
          [true, true],
          [false, false],
          ["true", false],
        ] as const
      ).map(
        ([nativeOnly, expected]) =>
          [
            `${name}, realtimeNativeOnly ${JSON.stringify(nativeOnly)}`,
            deps,
            flags,
            nativeOnly,
            expected,
          ] as const
      )
    )
  )("realtime %s", async (_name, deps, flags, nativeOnly, expected) => {
    const result = await enrolledRule(deps).rule(
      enrolledFlags({ ...flags, realtimeNativeOnly: nativeOnly })
    );
    expect(result).toBe(expected);
  });

  // Catches: the realtime backend resolved out of the flag's order (override, global, process default).
  it.each<
    [string, unknown, Record<string, unknown>, RuleDeps["env"]["REALTIME_BACKEND_DEFAULT"], boolean]
  >([
    ['no override, global "native"', undefined, { realtimeBackend: "native" }, "electric", true],
    ['no override, global "electric"', undefined, { realtimeBackend: "electric" }, "native", false],
    ['no override, no global, default "native"', undefined, {}, "native", true],
    ['no override, no global, default "electric"', undefined, {}, "electric", false],
    [
      'override "native", global "electric"',
      "native",
      { realtimeBackend: "electric" },
      "electric",
      true,
    ],
    [
      'override "electric", global "native"',
      "electric",
      { realtimeBackend: "native" },
      "native",
      false,
    ],
    ['override "fast", global "native"', "fast", { realtimeBackend: "native" }, "electric", true],
  ])("realtime backend: %s", async (_name, override, global, processDefault, expected) => {
    const { rule } = enrolledRule({
      env: { REALTIME_BACKEND_DEFAULT: processDefault },
      readGlobalFlags: globals(global),
    });
    expect(await rule(enrolledFlags({ realtimeBackend: override }))).toBe(expected);
  });

  // Catches: the mollifier condition reading the global value or ignoring the process switch.
  it.each<[string, Parameters<typeof enrolledRule>[0], Record<string, unknown>, boolean]>([
    [
      'override true, TRIGGER_MOLLIFIER_ENABLED "0"',
      { env: { TRIGGER_MOLLIFIER_ENABLED: "0" } },
      { mollifierEnabled: true },
      true,
    ],
    [
      "no override, global true",
      { readGlobalFlags: globals({ mollifierEnabled: true }) },
      { mollifierEnabled: undefined },
      true,
    ],
    ['override true, TRIGGER_MOLLIFIER_ENABLED "1"', {}, { mollifierEnabled: true }, false],
    ['override "true", which the gate coerces to on', {}, { mollifierEnabled: "true" }, false],
    [
      'override true, TRIGGER_MOLLIFIER_ENABLED "true", which the gate reads as off',
      { env: { TRIGGER_MOLLIFIER_ENABLED: "true" } },
      { mollifierEnabled: true },
      true,
    ],
  ])("mollifier: %s", async (_name, deps, flags, expected) => {
    expect(await enrolledRule(deps).rule(enrolledFlags(flags))).toBe(expected);
  });

  // Catches: the switch or the waitpoint flag read from the organisation alone, ignoring the global value.
  it.each(["runResidencyEnabled", "waitpointStoreEnabled"])(
    "reads %s's global value when the org has no override",
    async (key) => {
      const globalOn = { readGlobalFlags: globals({ [key]: true }) };
      expect(await enrolledRule(globalOn).rule(enrolledFlags({ [key]: undefined }))).toBe(true);
      expect(await enrolledRule(globalOn).rule(enrolledFlags({ [key]: false }))).toBe(false);
    }
  );

  // Catches: the rule passing no grace to the switch, so a change from on to off cuts over at once.
  it("holds the switch condition inside the grace of a change from on to off", async () => {
    const offFromOn = enrolledFlags({
      runResidencyEnabled: false,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: new Date().toISOString(),
    });
    expect(await enrolledRule({ graceMs: HOUR_MS }).rule(offFromOn)).toBe(true);
  });

  // Catches: null flags treated as "no flags in hand" by the rule, which then ignores the global values.
  it("treats null flags as flags in hand and reads the global values", async () => {
    const { rule } = enrolledRule({ readGlobalFlags: globals(ENROLLED_FLAGS) });
    expect(await rule(null)).toBe(true);
  });

  // Catches: other projects' flags coerced from a string, or read global before override.
  it.each(["activeRunStoreEnabled", "checkpointStoreEnabled", "clickhouseFeedEnabled"])(
    "reads %s by name",
    async (key) => {
      expect(await enrolledRule().rule(enrolledFlags({ [key]: "true" }))).toBe(false);
      const globalOn = { readGlobalFlags: globals({ [key]: true }) };
      expect(await enrolledRule(globalOn).rule(enrolledFlags({ [key]: false }))).toBe(false);
      expect(await enrolledRule(globalOn).rule(enrolledFlags({ [key]: undefined }))).toBe(true);
    }
  );

  // Catches: a read with no flags in hand, a global read per condition, or a split probe for an org whose switch is off.
  it("reads only what it needs", async () => {
    const none = enrolledRule({ readGlobalFlags: globals({ runResidencyEnabled: true }) });
    expect(await none.rule(undefined)).toBe(false);
    expect(none.calls).toEqual({ readGlobalFlags: 0, isSplitEnabled: 0 });

    const enrolled = enrolledRule();
    expect(await enrolled.rule(enrolledFlags())).toBe(true);
    expect(enrolled.calls.readGlobalFlags).toBe(1);

    const switchOff = enrolledRule();
    expect(await switchOff.rule(enrolledFlags({ runResidencyEnabled: false }))).toBe(false);
    expect(switchOff.calls.isSplitEnabled).toBe(0);

    // Split mode off: refused before either store URL is read.
    const urlReads: string[] = [];
    const env = { ...ENROLLED_ENV };
    for (const key of [
      "RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL",
      "RUN_ENGINE_WAITPOINT_STORE_REDIS_URL",
    ] as const) {
      Object.defineProperty(env, key, {
        get: () => (urlReads.push(key), ENROLLED_ENV[key]),
      });
    }
    const splitOff = createRunResidencyAllowedResolver({
      env,
      isSplitEnabled: async () => false,
      readGlobalFlags: () => ({}),
      graceMs: HOUR_MS,
    });
    expect(await splitOff(enrolledFlags())).toBe(false);
    expect(urlReads).toEqual([]);
  });

  // Catches: the rule warning on a path that did not throw.
  it("logs nothing when allowing or refusing without a throw", async () => {
    const warn = vi.spyOn(logger, "warn");
    try {
      expect(await enrolledRule().rule(enrolledFlags())).toBe(true);
      expect(await enrolledRule().rule(enrolledFlags({ clickhouseFeedEnabled: false }))).toBe(
        false
      );
      expect(await enrolledRule().rule(undefined)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(0);
    } finally {
      warn.mockRestore();
    }
  });

  // Catches: a failure while resolving rejecting the mint, or passing without its one warning.
  it.each<[string, Parameters<typeof enrolledRule>[0], () => unknown, string]>([
    [
      "a global-flags reader that throws",
      {
        readGlobalFlags: () => {
          throw new Error("registry broken");
        },
      },
      () => enrolledFlags(),
      "registry broken",
    ],
    [
      "an isSplitEnabled that rejects",
      { isSplitEnabled: () => Promise.reject(new Error("probe failed")) },
      () => enrolledFlags(),
      "probe failed",
    ],
    [
      "a runResidencyEnabled getter that throws",
      {},
      () =>
        Object.defineProperty(
          enrolledFlags({ runResidencyEnabled: undefined }),
          "runResidencyEnabled",
          {
            enumerable: true,
            get() {
              throw new Error("getter broken");
            },
          }
        ),
      "getter broken",
    ],
  ])("resolves false for %s", async (_name, deps, flags, message) => {
    const warn = vi.spyOn(logger, "warn");
    try {
      await expect(enrolledRule(deps).rule(flags())).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("runResidency.rule_failed", { error: message });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createRunResidencyGate", () => {
  const STAMP_AT = "2026-01-01T00:00:00.000Z";
  const organizations: Array<[string, unknown, boolean]> = [
    ["plain", null, false],
    ["never-on", { activeRunStoreEnabled: true }, false],
    ["on-record-off", { runResidencyEnabled: true, activeRunStoreEnabled: false }, false],
    ["on", { runResidencyEnabled: true, activeRunStoreEnabled: true }, true],
    [
      "was-on",
      {
        runResidencyEnabled: false,
        runResidencyEnabledPrev: true,
        runResidencyEnabledFlippedAt: STAMP_AT,
        activeRunStoreEnabled: true,
      },
      true,
    ],
  ];

  function countingGate(options: {
    global?: Record<string, unknown>;
    readGlobalFlags?: () => Partial<FeatureFlagCatalog> | undefined;
    resolve?: (
      environmentId: string
    ) => Promise<{ organization: { featureFlags: unknown } } | null>;
  }) {
    const lookups: string[] = [];
    const gate = createRunResidencyGate({
      readGlobalFlags: options.readGlobalFlags ?? globals(options.global ?? {}),
      resolveAuthenticatedEnv: (environmentId) => {
        lookups.push(environmentId);
        return options.resolve?.(environmentId) ?? Promise.resolve(null);
      },
    });
    return { gate, lookups };
  }

  const inScope = <T>(ctx: OrganizationContext | undefined, fn: () => T): T =>
    ctx === undefined ? fn() : organizationContext.run(ctx, fn);

  // Catches: the gate reading the switch's current value instead of "has been on", or opening
  // without the run record flag.
  it.each(organizations)("%s, flags in hand", async (_name, featureFlags, expected) => {
    const { gate, lookups } = countingGate({});
    const ctx = { organizationId: "org_1", environmentId: "env_1", featureFlags };
    await expect(inScope(ctx, () => gate.organizationOpens())).resolves.toBe(expected);
    expect(lookups).toEqual([]);
  });

  // Catches: a look-up whose flags are read differently from the flags in hand.
  it.each(organizations)("%s, through the look-up", async (_name, featureFlags, expected) => {
    const { gate, lookups } = countingGate({
      resolve: async () => ({ organization: { featureFlags } }),
    });
    const ctx = { environmentId: "env_1" };
    await expect(inScope(ctx, () => gate.organizationOpens())).resolves.toBe(expected);
    expect(lookups).toEqual(["env_1"]);
  });

  // Catches: the global value or the global stamp of the switch being ignored.
  it.each<[string, Record<string, unknown>, unknown, boolean]>([
    ["global switch on", { runResidencyEnabled: true }, { activeRunStoreEnabled: true }, true],
    [
      "global stamp on",
      { runResidencyEnabledPrev: true, runResidencyEnabledFlippedAt: STAMP_AT },
      { activeRunStoreEnabled: true },
      true,
    ],
    [
      "global stamp on, organisation override off",
      { runResidencyEnabledPrev: true, runResidencyEnabledFlippedAt: STAMP_AT },
      { runResidencyEnabled: false, activeRunStoreEnabled: true },
      false,
    ],
  ])("%s", async (_name, global, featureFlags, expected) => {
    const { gate } = countingGate({ global });
    const ctx = { organizationId: "org_1", environmentId: "env_1", featureFlags };
    await expect(inScope(ctx, () => gate.organizationOpens())).resolves.toBe(expected);
  });

  // Catches: a gate that opens, or looks up, for a call with no environment in its context.
  it.each<[string, OrganizationContext | undefined]>([
    ["no scope", undefined],
    ["an empty scope", {}],
    [
      "a scope with flags but no environment",
      {
        organizationId: "org_1",
        featureFlags: { runResidencyEnabled: true, activeRunStoreEnabled: true },
      },
    ],
  ])("is closed with %s", async (_name, ctx) => {
    const { gate, lookups } = countingGate({
      global: { runResidencyEnabled: true, activeRunStoreEnabled: true },
      resolve: async () => ({ organization: { featureFlags: null } }),
    });
    await expect(inScope(ctx, () => gate.organizationOpens())).resolves.toBe(false);
    expect(lookups).toEqual([]);
  });

  // Catches: a missing environment read as an organisation with no overrides.
  it("is closed for an environment the resolver does not find", async () => {
    const { gate, lookups } = countingGate({
      global: { runResidencyEnabled: true, activeRunStoreEnabled: true },
    });
    await expect(
      inScope({ environmentId: "env_gone" }, () => gate.organizationOpens())
    ).resolves.toBe(false);
    expect(lookups).toEqual(["env_gone"]);
  });

  // Catches: bornHere() reading anything but the scope's mark.
  it("bornHere() answers the scope's mark alone, with no look-up", () => {
    const { gate, lookups } = countingGate({});
    expect(
      inScope({ environmentId: "env_1", featureFlags: null, bornHere: true }, () => gate.bornHere())
    ).toBe(true);
    expect(inScope({ bornHere: true }, () => gate.bornHere())).toBe(true);
    expect(gate.bornHere()).toBe(false);
    expect(inScope({ environmentId: "env_1" }, () => gate.bornHere())).toBe(false);
    expect(lookups).toEqual([]);
  });

  // Catches: a look-up per operation instead of per scope, or a cache kept across scopes.
  it("looks up once per scope, and again in a new scope", async () => {
    const on = { runResidencyEnabled: true, activeRunStoreEnabled: true };
    const { gate, lookups } = countingGate({
      resolve: async () => ({ organization: { featureFlags: on } }),
    });
    const ask = () =>
      Promise.all([gate.organizationOpens(), gate.organizationOpens(), gate.organizationOpens()]);
    await expect(inScope({ environmentId: "env_1" }, ask)).resolves.toEqual([true, true, true]);
    expect(lookups).toEqual(["env_1"]);
    await expect(inScope({ environmentId: "env_1" }, ask)).resolves.toEqual([true, true, true]);
    expect(lookups).toEqual(["env_1", "env_1"]);
  });

  // Catches: null flags read as no flags in hand, which would add a look-up to every request.
  it("does not look up when the flags in hand are null", async () => {
    const { gate, lookups } = countingGate({
      resolve: async () => ({
        organization: { featureFlags: { runResidencyEnabled: true, activeRunStoreEnabled: true } },
      }),
    });
    await expect(
      inScope({ environmentId: "env_1", featureFlags: null }, () => gate.organizationOpens())
    ).resolves.toBe(false);
    expect(lookups).toEqual([]);
  });

  // Catches: a failed look-up read as a closed gate, which would hide an enrolled organisation's runs.
  it("rejects with the look-up's error", async () => {
    const failure = new Error("control plane down");
    const { gate } = countingGate({ resolve: () => Promise.reject(failure) });
    await expect(inScope({ environmentId: "env_1" }, () => gate.organizationOpens())).rejects.toBe(
      failure
    );
  });

  // Catches: a throw while deciding failing the operation, or passing without its one warning.
  it("resolves false and warns once when the global-flags reader throws", async () => {
    const warn = vi.spyOn(logger, "warn");
    try {
      const { gate } = countingGate({
        readGlobalFlags: () => {
          throw new Error("registry broken");
        },
      });
      const ctx = { environmentId: "env_1", featureFlags: { activeRunStoreEnabled: true } };
      await expect(inScope(ctx, () => gate.organizationOpens())).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("runResidency.gate_failed", { error: "registry broken" });
    } finally {
      warn.mockRestore();
    }
  });

  // Catches: the gate warning on a decision that did not throw.
  it("logs nothing when opening or closing without a throw", async () => {
    const warn = vi.spyOn(logger, "warn");
    try {
      const { gate } = countingGate({});
      for (const [, featureFlags] of organizations) {
        await inScope({ environmentId: "env_1", featureFlags }, () => gate.organizationOpens());
      }
      expect(warn).toHaveBeenCalledTimes(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("splitRunStoreDeps", () => {
  // Catches: the runStore singleton building its router with no gate, or a gate whose look-up
  // does not reach the control-plane resolver.
  postgresTest(
    "gives the singleton a gate that looks up an environment's flags through the control-plane resolver",
    async ({ prisma }) => {
      db.client = prisma;
      const organization = await prisma.organization.create({
        data: {
          title: "Gate org",
          slug: "gate-org",
          featureFlags: { runResidencyEnabled: true, activeRunStoreEnabled: true },
        },
      });
      const project = await prisma.project.create({
        data: {
          name: "Gate project",
          slug: "gate-project",
          externalRef: "proj_gate",
          organizationId: organization.id,
        },
      });
      const environment = await prisma.runtimeEnvironment.create({
        data: {
          type: "DEVELOPMENT",
          slug: "dev",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "tr_dev_gate",
          pkApiKey: "pk_dev_gate",
          shortcode: "short_gate",
        },
      });
      const stub = {} as never;
      const deps = splitRunStoreDeps({
        newWriter: stub,
        newReplica: stub,
        legacyWriter: stub,
        legacyReplica: stub,
        shardHandles: [],
      });

      expect(deps.memoryDbGate).toBeDefined();
      await expect(
        organizationContext.run({ environmentId: environment.id }, () =>
          deps.memoryDbGate!.organizationOpens()
        )
      ).resolves.toBe(true);
      await expect(
        organizationContext.run({ environmentId: "env_missing" }, () =>
          deps.memoryDbGate!.organizationOpens()
        )
      ).resolves.toBe(false);
    }
  );
});

describe("checkpointStoreEnabled flag", () => {
  // Catches: a coercing schema that turns the string "false" on, or the key unknown or locked.
  it("is registered as a strict boolean flag, settable per organization and globally", () => {
    expect(FEATURE_FLAG.checkpointStoreEnabled).toBe("checkpointStoreEnabled");
    const schema = FeatureFlagCatalog[FEATURE_FLAG.checkpointStoreEnabled];
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(false).success).toBe(true);
    expect(schema.safeParse("false").success).toBe(false);
    expect(schema.safeParse("true").success).toBe(false);
    const stored = parseStoredOrgFlags({ checkpointStoreEnabled: true });
    expect(stored.valid).toEqual({ checkpointStoreEnabled: true });
    expect(stored.unknownKeys).not.toHaveProperty("checkpointStoreEnabled");
    expect(GLOBAL_LOCKED_FLAGS).not.toContain(FEATURE_FLAG.checkpointStoreEnabled);
    expect(ORG_LOCKED_FLAGS).not.toContain(FEATURE_FLAG.checkpointStoreEnabled);
  });
});
