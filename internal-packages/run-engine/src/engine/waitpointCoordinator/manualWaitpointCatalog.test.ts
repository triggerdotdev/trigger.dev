import { createHash } from "node:crypto";
import { createRedisClient } from "@internal/redis";
import { isolatedRedisTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import {
  fanoutPartition,
  organizationPendingSourceIndexKey,
  registrationEvidence,
  waitpointKeys,
} from "./keys.js";
import {
  ManualWaitpointCatalog,
  manualWaitpointCatalogManifestKey,
} from "./manualWaitpointCatalog.js";
import { WaitpointStoreCoordinator, type WaitpointRecordInput } from "./storeCoordinator.js";

const ORG = "org_catalog";
const ENV = "env_catalog";
const CREATED = "2026-01-01T00:00:00.000Z";

function record(id: string, overrides: Partial<WaitpointRecordInput> = {}): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    organizationId: ORG,
    environmentId: ENV,
    projectId: "project_catalog",
    createdAt: CREATED,
    updatedAt: CREATED,
    userProvidedIdempotencyKey: false,
    tags: [],
    ...overrides,
  };
}

function index(suffix: string, organizationId = ORG, environmentId = ENV) {
  const tenant = createHash("sha256")
    .update(JSON.stringify([organizationId, environmentId]))
    .digest("hex");
  return `wp:v1:manual:{${tenant}}:${suffix}`;
}

function setup(redisOptions: Parameters<typeof createRedisClient>[0]) {
  const redis = createRedisClient(redisOptions);
  const store = new WaitpointStoreCoordinator({ client: redis });
  const catalog = new ManualWaitpointCatalog({
    redis,
    readRecords: (ids) => store.readCompletedRecords(ids),
  });
  const publish = async (input: WaitpointRecordInput, acceptUntil = Date.now() + 60_000) => {
    await catalog.publish(input, acceptUntil);
    await store.createIfAbsent({ record: input, status: "PENDING" });
  };
  return { redis, store, catalog, publish };
}

const input = { organizationId: ORG, environmentId: ENV, direction: "forward" as const, limit: 2 };

const OTHER_ENV = "env_catalog_other";
const at = (seconds: number) => new Date(Date.parse(CREATED) + seconds * 1_000).toISOString();
type ListInput = Parameters<ManualWaitpointCatalog["list"]>[0];
type Page = Awaited<ReturnType<ManualWaitpointCatalog["list"]>>;
type Tokens = { record: WaitpointRecordInput; outputIsError?: boolean }[];

async function seed({ store, catalog, publish }: ReturnType<typeof setup>, tokens: Tokens) {
  for (let offset = 0; offset < tokens.length; offset += 100)
    await Promise.all(
      tokens.slice(offset, offset + 100).map(async ({ record, outputIsError }) => {
        await publish(record);
        if (outputIsError === undefined) return;
        await catalog.publishCompletedCandidate(record, outputIsError);
        await store.complete({
          waitpointId: record.id,
          completion: {
            completedAt: CREATED,
            outputType: "application/json",
            outputIsError,
            output: null,
          },
        });
      })
    );
}

// Token n is created n seconds in, so a higher id is newer. "common" is held by the newest 300 and
// the 6 oldest; of those only the 6 oldest are completed. "rare-a" and "rare-b" are on the oldest.
// "even" and "eighth" are tag streams that advance at different rates through the same ids.
function catalogTokens(environmentId: string, size: number): Tokens {
  return Array.from({ length: size }, (_, n) => {
    const completed = n < 6 || (n < size - 300 && n % 3 !== 0);
    return {
      record: record(`${environmentId}_${String(n).padStart(5, "0")}`, {
        environmentId,
        createdAt: at(n),
        idempotencyKey: n % 7 === 0 ? `key-${n}` : undefined,
        tags: [
          `t${n % 200}`,
          ...(n < 6 ? [n < 3 ? "rare-a" : "rare-b"] : []),
          ...(n < 6 || n >= size - 300 ? ["common"] : []),
          ...(n % 2 === 0 ? ["even"] : []),
          ...(n % 8 === 0 ? ["eighth"] : []),
        ],
      }),
      outputIsError: completed ? n % 2 === 1 : undefined,
    };
  });
}

function filterSet(environmentId: string, size: number): Record<string, Partial<ListInput>> {
  return {
    none: {},
    id: { id: `${environmentId}_00005` },
    otherEnvironmentId: { id: `${OTHER_ENV}_00001` },
    pending: { statuses: ["PENDING"] },
    success: { statuses: ["COMPLETED"], outputIsError: false },
    error: { outputIsError: true },
    pendingOrCompleted: { statuses: ["PENDING", "COMPLETED"] },
    idempotencyKey: { idempotencyKey: "key-14" },
    oneTag: { tags: ["common"] },
    threeTags: { tags: ["rare-a", "rare-b", "t7"] },
    twoTagsPending: { tags: ["even", "eighth"], statuses: ["PENDING"] },
    manyTags: { tags: Array.from({ length: 150 }, (_, n) => `t${n}`) },
    createdAtGte: { createdAtGte: at(size / 2) },
    createdAtLte: { createdAtLte: at(size / 3) },
    window: { createdAtGte: at(size / 3), createdAtLte: at(size / 2) },
    windowHoldingAll: { createdAtGte: at(-1_000), createdAtLte: at(size + 1_000) },
    tagWithAbsentStatus: { tags: ["rare-b"], statuses: ["PENDING"] },
    commonTagCompleted: { tags: ["common"], statuses: ["COMPLETED"] },
    combined: {
      idempotencyKey: "key-0",
      tags: ["rare-a"],
      statuses: ["COMPLETED"],
      createdAtGte: at(0),
      createdAtLte: at(10),
    },
  };
}

/** CONFIG RESETSTAT before the call, INFO commandstats after it, without the config and info entries. */
async function commandCount<T>(
  redis: ReturnType<typeof createRedisClient>,
  call: () => Promise<T>
) {
  await redis.config("RESETSTAT");
  const result = await call();
  let commands = 0;
  for (const [, name, calls] of (await redis.info("commandstats")).matchAll(
    /^cmdstat_([^:]+):calls=(\d+)/gm
  ))
    if (!/^(config|info)\b/.test(name!)) commands += Number(calls);
  return { result, commands };
}

/** Continue from continueCursor if set, else from the last id of a full page, else stop. */
function nextCursor(page: Page, limit: number) {
  return (
    page.continueCursor ??
    (page.records.length === limit ? page.records.at(-1)!.record.id : undefined)
  );
}

async function walk(catalog: ManualWaitpointCatalog, filter: ListInput) {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    pages.push(await catalog.list({ ...filter, cursor }));
    cursor = nextCursor(pages.at(-1)!, filter.limit);
  } while (cursor);
  return { pages, ids: pages.flatMap((page) => page.records.map((item) => item.record.id)) };
}

// Real isolated Redis, including failure injection through real Redis WRONGTYPE errors. No workers.
describe("ManualWaitpointCatalog", () => {
  isolatedRedisTest(
    "catalog retirement stays scheduled until an interrupted registration releases its source",
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis, terminalRetentionMs: 50 });
      const source = record(generateWaitpointId("MANUAL"));
      const hold = {
        runId: "catalog-held",
        blockId: "B1",
        absorptionId: "A1",
        waitpointIds: [source.id],
        evidence: registrationEvidence([source.id]),
      };
      try {
        await store.manualCatalog.publish(source, Date.now() + 100);
        await store.createIfAbsent({ record: source, status: "PENDING" });
        await store.prepareRegistrationSources(hold);
        await store.complete({
          waitpointId: source.id,
          completion: {
            completedAt: CREATED,
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        expect(await redis.pttl(waitpointKeys(source.id).record)).toBe(-1);
        expect(await store.retireManualCatalog(source.id, ORG)).toBeGreaterThan(Date.now());
        await store.deleteContribution(hold);
        await expect.poll(() => redis.exists(waitpointKeys(source.id).record)).toBe(0);
        await expect
          .poll(async () => {
            await store.retireManualCatalog(source.id, ORG);
            return store.manualCatalog.getManifest(ORG, source.id);
          })
          .toBeUndefined();
        expect(
          await redis.zscore(
            organizationPendingSourceIndexKey(ORG, fanoutPartition(source.id)),
            source.id
          )
        ).toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );

  isolatedRedisTest(
    "lists exact original keys after expiry, tag ORs and cursor pages within the tenant",
    async ({ redisOptions }) => {
      const { redis, catalog, publish } = setup(redisOptions);
      try {
        await publish(
          record("a", {
            idempotencyKey: "original",
            idempotencyKeyExpiresAt: "2020-01-01T00:00:00Z",
            tags: ["red"],
          })
        );
        await publish(record("b", { idempotencyKey: "original", tags: ["blue"] }));
        await publish(record("c", { idempotencyKey: "other", tags: ["red", "blue"] }));
        await publish(record("d", { tags: ["green"] }));
        await publish(
          record("z", { environmentId: "env_other", idempotencyKey: "original", tags: ["red"] })
        );
        await publish(
          record("y", { organizationId: "org_other", idempotencyKey: "original", tags: ["red"] })
        );
        expect(
          (
            await catalog.list({ ...input, idempotencyKey: "original", tags: ["red", "blue"] })
          ).records.map((item) => item.record.id)
        ).toEqual(["b", "a"]);
        expect(
          (await catalog.list({ ...input, tags: ["blue", "red"] })).records.map(
            (item) => item.record.id
          )
        ).toEqual(["c", "b"]);
        expect(
          (await catalog.list({ ...input, tags: ["red", "blue"], cursor: "b" })).records.map(
            (item) => item.record.id
          )
        ).toEqual(["a"]);
        expect(
          (
            await catalog.list({
              ...input,
              tags: ["red", "blue"],
              cursor: "a",
              direction: "backward",
            })
          ).records.map((item) => item.record.id)
        ).toEqual(["b", "c"]);
        // A selective key must not even read the broad environment index.
        await redis.del(index("ids"));
        await redis.set(index("ids"), "unusable broad index");
        expect(
          (await catalog.list({ ...input, idempotencyKey: "original" })).records.map(
            (item) => item.record.id
          )
        ).toEqual(["b", "a"]);
      } finally {
        await redis.quit();
      }
    }
  );

  isolatedRedisTest(
    "hydrates authoritative status and error, including candidates published before a completion",
    async ({ redisOptions }) => {
      const { redis, catalog, store, publish } = setup(redisOptions);
      try {
        const pending = record("pending");
        const success = record("success");
        const error = record("error");
        for (const value of [pending, success, error]) await publish(value);
        await catalog.publishCompletedCandidate(pending, true);
        expect(
          (await catalog.list({ ...input, statuses: ["COMPLETED"], outputIsError: true })).records
        ).toEqual([]);
        for (const [value, outputIsError] of [
          [success, false],
          [error, true],
        ] as const) {
          await catalog.publishCompletedCandidate(value, outputIsError);
          await catalog.publishCompletedCandidate(value, !outputIsError);
          await store.complete({
            waitpointId: value.id,
            completion: {
              completedAt: CREATED,
              outputType: "application/json",
              outputIsError,
              output: { inline: "{}" },
            },
          });
        }
        expect(
          (await catalog.list({ ...input, id: success.id })).records[0]?.completion?.output
        ).toBeNull();
        expect(
          (await catalog.list({ ...input, statuses: ["COMPLETED"] })).records.every(
            (item) => item.completion?.output === null
          )
        ).toBe(true);
        expect(
          (await store.readCompletedRecords([success.id])).get(success.id)?.completion?.output
        ).toEqual({ inline: "{}" });
        for (const value of [success, error]) {
          await catalog.reconcileStatus(value);
          await catalog.reconcileStatus(value);
        }
        expect(await redis.zrange(index("status:PENDING"), 0, -1)).toEqual(["pending"]);
        expect(await redis.zrange(index("status:error"), 0, -1)).toEqual(["error", "pending"]);
        expect(await redis.zrange(index("status:success"), 0, -1)).toEqual(["success"]);
        expect(
          (await catalog.list({ ...input, statuses: ["PENDING"] })).records.map(
            (item) => item.record.id
          )
        ).toEqual(["pending"]);
        expect(
          (
            await catalog.list({ ...input, statuses: ["COMPLETED"], outputIsError: false })
          ).records.map((item) => item.record.id)
        ).toEqual(["success"]);
        expect(
          (await catalog.list({ ...input, outputIsError: true })).records.map(
            (item) => item.record.id
          )
        ).toEqual(["error"]);
        expect(
          (await catalog.list({ ...input, outputIsError: false })).records.map(
            (item) => item.record.id
          )
        ).toEqual(["success", "pending"]);

        // Maintenance replays an interrupted candidate publication for an untimed live source.
        const repairEnvironment = "env_repair";
        const pendingRepair = record(generateWaitpointId("MANUAL"), {
          environmentId: repairEnvironment,
        });
        await publish(pendingRepair);
        await catalog.publishCompletedCandidate(pendingRepair, true);
        await store.retireManualCatalog(pendingRepair.id, ORG);
        expect(
          await redis.zscore(index("status:PENDING", ORG, repairEnvironment), pendingRepair.id)
        ).toBe("0");
        for (const status of ["COMPLETED", "error", "success"])
          expect(
            await redis.zscore(index(`status:${status}`, ORG, repairEnvironment), pendingRepair.id)
          ).toBeNull();

        // A permanently retained completion survives a producer crash before status reconciliation.
        // Seed only the losing candidate, as an operator's direct canonical flip may do.
        const permanent = record(generateWaitpointId("MANUAL"), {
          environmentId: repairEnvironment,
          idempotencyKey: "permanent",
        });
        await publish(permanent);
        await catalog.publishCompletedCandidate(permanent, false);
        await store.complete({
          waitpointId: permanent.id,
          completion: {
            completedAt: CREATED,
            outputType: "application/json",
            outputIsError: true,
            output: { inline: "{}" },
          },
        });
        expect(await redis.pttl(waitpointKeys(permanent.id).record)).toBe(-1);
        expect(
          await redis.zscore(index("status:PENDING", ORG, repairEnvironment), permanent.id)
        ).toBe("0");
        expect(
          await redis.zscore(index("status:error", ORG, repairEnvironment), permanent.id)
        ).toBeNull();
        await store.retireManualCatalog(permanent.id, ORG);
        await store.retireManualCatalog(permanent.id, ORG);
        expect(
          await redis.zscore(index("status:COMPLETED", ORG, repairEnvironment), permanent.id)
        ).toBe("0");
        expect(
          await redis.zscore(index("status:error", ORG, repairEnvironment), permanent.id)
        ).toBe("0");
        expect(
          await redis.zscore(index("status:PENDING", ORG, repairEnvironment), permanent.id)
        ).toBeNull();
        expect(
          await redis.zscore(index("status:success", ORG, repairEnvironment), permanent.id)
        ).toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );

  isolatedRedisTest(
    "indexes actual creation time and returns ID order across multiple bounded date pages",
    async ({ redisOptions }) => {
      const { redis, catalog, publish } = setup(redisOptions);
      try {
        // Reverse timestamps prevent either the first time page or ID-derived time from passing.
        for (let n = 0; n < 140; n++)
          await publish(
            record(String(n).padStart(3, "0"), {
              createdAt: new Date(Date.parse(CREATED) + (140 - n) * 1_000).toISOString(),
            })
          );
        await redis.del(index("ids"));
        await redis.set(index("ids"), "a date query must use the date index");
        const filter = {
          ...input,
          createdAtGte: CREATED,
          createdAtLte: "2026-01-01T00:02:20.000Z",
        };
        expect((await catalog.list(filter)).records.map((item) => item.record.id)).toEqual([
          "139",
          "138",
        ]);
        expect(
          (await catalog.list({ ...filter, cursor: "138" })).records.map((item) => item.record.id)
        ).toEqual(["137", "136"]);
        expect(
          (await catalog.list({ ...filter, createdAtGte: "2026-01-01T00:02:19.000Z" })).records.map(
            (item) => item.record.id
          )
        ).toEqual(["001", "000"]);
        expect(
          (await catalog.list({ ...filter, direction: "backward" })).records.map(
            (item) => item.record.id
          )
        ).toEqual(["000", "001"]);
      } finally {
        await redis.quit();
      }
    }
  );

  isolatedRedisTest(
    "retains durable manifests on failed facet deletion and retries after canonical expiry",
    async ({ redisOptions }) => {
      const { redis, catalog, store, publish } = setup(redisOptions);
      try {
        const source = record(generateWaitpointId("MANUAL"), {
          tags: Array.from({ length: 80 }, (_, n) => `tag-${n}`),
          idempotencyKey: "original",
        });
        await publish(source, Date.now() + 1_000);
        const manifest = (await catalog.getManifest(ORG, source.id))!;
        const metadata = manualWaitpointCatalogManifestKey(ORG, source.id);
        const owner = organizationPendingSourceIndexKey(ORG, fanoutPartition(source.id));
        expect(await catalog.retire(manifest)).toBe(false);
        await redis.del(waitpointKeys(source.id).record);
        expect(await catalog.retire(manifest)).toBe(false); // An absent source alone cannot close publication.
        await expect
          .poll(
            async () => {
              const time = await redis.time();
              return Number(time[0]) * 1_000 + Number(time[1]) / 1_000 > manifest.acceptUntil;
            },
            { timeout: 3_000, interval: 20, message: "catalog publication fence never closed" }
          )
          .toBe(true);
        const failedFacet = index("status:COMPLETED");
        await redis.set(failedFacet, "wrong type");
        await expect(catalog.retire(manifest)).rejects.toThrow(/WRONGTYPE/);
        expect(await redis.hexists(metadata, source.id)).toBe(1);
        expect(await redis.zscore(owner, source.id)).toBe("0");
        await redis.del(failedFacet);
        expect(await catalog.retire(manifest)).toBe(true);
        expect(await catalog.retire(manifest)).toBe(true);
        expect(await catalog.getManifest(ORG, source.id)).toBeUndefined();
        await expect(catalog.publish(source, manifest.acceptUntil)).rejects.toThrow(
          /publication fence closed/
        );
        expect(await catalog.getManifest(ORG, source.id)).toBeUndefined();
        const neverPublished = record("closed-before-publication");
        await expect(catalog.publish(neverPublished, 0)).rejects.toThrow(
          /publication fence closed/
        );
        expect(await catalog.getManifest(ORG, neverPublished.id)).toBeUndefined();
        expect(
          await redis.zscore(
            organizationPendingSourceIndexKey(ORG, fanoutPartition(neverPublished.id)),
            neverPublished.id
          )
        ).toBeNull();
        expect(await redis.zcard(index("ids"))).toBe(0);
        for (const tag of source.tags) {
          const hash = createHash("sha256").update(tag).digest("hex");
          expect(await redis.zcard(index(`tag:${hash}`))).toBe(0);
        }
        // Source discovery belongs to the caller's final receipt/fanout-aware retirement step.
        expect(await redis.zscore(owner, source.id)).toBe("0");
        // A crash after manifest HDEL but before discovery ACK must converge on maintenance replay.
        await store.retireManualCatalog(source.id, ORG);
        expect(await redis.zscore(owner, source.id)).toBeNull();
        await store.retireManualCatalog(source.id, ORG);
        expect(await redis.zscore(owner, source.id)).toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );

  // Catches: a list call with a command ceiling of 100 issuing more than 100 store commands.
  isolatedRedisTest(
    "a command ceiling bounds the first two calls of every filtered walk at 300 and 3,000 tokens",
    async ({ redisOptions }) => {
      const context = setup(redisOptions);
      try {
        const sizes = { env_ceiling_300: 300, env_ceiling_3000: 3_000 };
        await seed(context, [
          ...Object.entries(sizes).flatMap(([env, size]) => catalogTokens(env, size)),
          ...catalogTokens(OTHER_ENV, 5),
        ]);
        for (const [environmentId, size] of Object.entries(sizes))
          for (const [name, filter] of Object.entries(filterSet(environmentId, size)))
            for (const direction of ["forward", "backward"] as const)
              for (const limit of [26, 101]) {
                const list = { ...input, ...filter, environmentId, direction, limit };
                let cursor: string | undefined;
                for (let call = 1; call <= 2; call++) {
                  const { result, commands } = await commandCount(context.redis, () =>
                    context.catalog.list({ ...list, cursor, commandCeiling: 100 })
                  );
                  const label = `${size} ${name} ${direction} ${limit} call ${call}`;
                  expect(commands, label).toBeGreaterThan(0);
                  expect(commands, label).toBeLessThanOrEqual(100);
                  cursor = nextCursor(result, limit);
                  if (!cursor) break;
                }
              }
      } finally {
        await context.redis.quit();
      }
    }
  );

  // Catches: the ceiling's stop filter changing a list made without a ceiling, which every caller
  // outside the standalone token list still makes.
  isolatedRedisTest(
    "a list without a command ceiling returns the newest matches of several tags and statuses",
    async ({ redisOptions }) => {
      const context = setup(redisOptions);
      try {
        const tokens = catalogTokens(ENV, 600);
        await seed(context, tokens);
        const filters = {
          twoTagsPending: { tags: ["even", "eighth"], statuses: ["PENDING" as const] },
          twoTagsAnyStatus: {
            tags: ["even", "eighth"],
            statuses: ["PENDING" as const, "COMPLETED" as const],
          },
        };
        for (const [name, filter] of Object.entries(filters))
          for (const direction of ["forward", "backward"] as const) {
            const matching = tokens
              .filter(
                ({ record, outputIsError }) =>
                  filter.tags.some((tag) => record.tags.includes(tag)) &&
                  filter.statuses.includes(outputIsError === undefined ? "PENDING" : "COMPLETED")
              )
              .map(({ record }) => record.id)
              .sort();
            if (direction === "forward") matching.reverse();
            expect(matching.length, name).toBeGreaterThan(64);
            const page = await context.catalog.list({ ...input, ...filter, direction, limit: 26 });
            expect(
              page.records.map((item) => item.record.id),
              `${name} ${direction}`
            ).toEqual(matching.slice(0, 26));
            expect(page.continueCursor).toBeUndefined();
          }
      } finally {
        await context.redis.quit();
      }
    }
  );

  // Catches: a walk with a command ceiling skipping, repeating or reordering tokens.
  isolatedRedisTest(
    "a walk with a command ceiling returns the same tokens in the same order as one without",
    async ({ redisOptions }) => {
      const context = setup(redisOptions);
      try {
        await seed(context, [...catalogTokens(ENV, 600), ...catalogTokens(OTHER_ENV, 5)]);
        let continued = 0;
        for (const [name, filter] of Object.entries(filterSet(ENV, 600)))
          for (const direction of ["forward", "backward"] as const) {
            const list = { ...input, ...filter, direction, limit: 26 };
            const unbounded = await walk(context.catalog, list);
            const bounded = await walk(context.catalog, { ...list, commandCeiling: 100 });
            expect(bounded.ids, `${name} ${direction}`).toEqual(unbounded.ids);
            expect(unbounded.pages.every((page) => page.continueCursor === undefined)).toBe(true);
            continued += bounded.pages.filter((page) => page.continueCursor).length;
          }
        expect(continued).toBeGreaterThan(0);
      } finally {
        await context.redis.quit();
      }
    }
  );

  // Catches: a ceiling walk to a rare match stalling on a cursor or missing a match, and a ceiling
  // too small for any progress not being refused.
  isolatedRedisTest(
    "a rare tag and status match behind large indexes is reached through advancing cursors",
    async ({ redisOptions }) => {
      const context = setup(redisOptions);
      try {
        // Ids interleave: rare token j is 2j, untagged completed token k is 2k + 1.
        const id = (n: number) => `rare_${String(n).padStart(5, "0")}`;
        await seed(context, [
          ...Array.from({ length: 305 }, (_, j) => ({
            record: record(id(2 * j), { tags: ["rare"] }),
            outputIsError: j < 5 ? false : undefined,
          })),
          ...Array.from({ length: 300 }, (_, k) => ({
            record: record(id(2 * k + 1)),
            outputIsError: false,
          })),
        ]);
        const rareTag = `tag:${createHash("sha256").update("rare").digest("hex")}`;
        for (const facet of [rareTag, "status:success", "status:COMPLETED"])
          expect(await context.redis.zcard(index(facet))).toBeGreaterThanOrEqual(300);
        const list = {
          ...input,
          tags: ["rare"],
          statuses: ["COMPLETED" as const],
          outputIsError: false,
          limit: 26,
        };
        for (const commandCeiling of [100, 2]) {
          const { pages, ids } = await walk(context.catalog, { ...list, commandCeiling });
          expect(pages[0]!.records.length).toBeLessThan(26);
          expect(pages[0]!.continueCursor).toBeDefined();
          const cursors = pages.flatMap((page) => page.continueCursor ?? []);
          for (let n = 1; n < cursors.length; n++)
            expect(cursors[n]! < cursors[n - 1]!, `${commandCeiling} ${n}`).toBe(true);
          expect(pages.at(-1)!.continueCursor).toBeUndefined();
          expect(ids).toEqual([8, 6, 4, 2, 0].map(id));
        }
        await expect(context.catalog.list({ ...list, commandCeiling: 1 })).rejects.toThrow(
          /command ceiling/
        );
      } finally {
        await context.redis.quit();
      }
    }
  );
});
