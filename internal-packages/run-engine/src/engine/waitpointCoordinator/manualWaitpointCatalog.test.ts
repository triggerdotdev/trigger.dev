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
          (await catalog.list({ ...input, idempotencyKey: "original", tags: ["red", "blue"] })).map(
            (item) => item.record.id
          )
        ).toEqual(["b", "a"]);
        expect(
          (await catalog.list({ ...input, tags: ["blue", "red"] })).map((item) => item.record.id)
        ).toEqual(["c", "b"]);
        expect(
          (await catalog.list({ ...input, tags: ["red", "blue"], cursor: "b" })).map(
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
          ).map((item) => item.record.id)
        ).toEqual(["b", "c"]);
        // A selective key must not even read the broad environment index.
        await redis.del(index("ids"));
        await redis.set(index("ids"), "unusable broad index");
        expect(
          (await catalog.list({ ...input, idempotencyKey: "original" })).map(
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
          await catalog.list({ ...input, statuses: ["COMPLETED"], outputIsError: true })
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
          (await catalog.list({ ...input, id: success.id }))[0]?.completion?.output
        ).toBeNull();
        expect(
          (await catalog.list({ ...input, statuses: ["COMPLETED"] })).every(
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
          (await catalog.list({ ...input, statuses: ["PENDING"] })).map((item) => item.record.id)
        ).toEqual(["pending"]);
        expect(
          (await catalog.list({ ...input, statuses: ["COMPLETED"], outputIsError: false })).map(
            (item) => item.record.id
          )
        ).toEqual(["success"]);
        expect(
          (await catalog.list({ ...input, outputIsError: true })).map((item) => item.record.id)
        ).toEqual(["error"]);
        expect(
          (await catalog.list({ ...input, outputIsError: false })).map((item) => item.record.id)
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
        expect((await catalog.list(filter)).map((item) => item.record.id)).toEqual(["139", "138"]);
        expect(
          (await catalog.list({ ...filter, cursor: "138" })).map((item) => item.record.id)
        ).toEqual(["137", "136"]);
        expect(
          (await catalog.list({ ...filter, createdAtGte: "2026-01-01T00:02:19.000Z" })).map(
            (item) => item.record.id
          )
        ).toEqual(["001", "000"]);
        expect(
          (await catalog.list({ ...filter, direction: "backward" })).map((item) => item.record.id)
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
});
