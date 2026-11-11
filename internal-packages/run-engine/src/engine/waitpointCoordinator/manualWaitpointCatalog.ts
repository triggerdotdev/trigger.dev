import { createHash } from "node:crypto";
import type { RedisClient } from "@internal/redis";
import { assertSingleSlot, fanoutPartition, organizationPendingSourceIndexKey } from "./keys.js";
import type { WaitpointRecordInput, WaitpointStoredRecord } from "./storeCoordinator.js";

const PAGE_SIZE = 64;
const MAX_DATE = 8_640_000_000_000_000;

/** Immutable cleanup evidence; deliberately contains no completion payload. No TTL. */
export type ManualWaitpointCatalogManifest = {
  version: 1;
  organizationId: string;
  environmentId: string;
  waitpointId: string;
  idempotencyKey?: string;
  tags: string[];
  createdAt: string;
  acceptUntil: number;
};

/** A hash field per source, in the SAME slot as its existing organization discovery owner. */
export function manualWaitpointCatalogManifestKey(organizationId: string, waitpointId: string) {
  return `${organizationPendingSourceIndexKey(organizationId, fanoutPartition(waitpointId))}:manual-catalog`;
}

export function parseManualWaitpointCatalogManifest(raw: string): ManualWaitpointCatalogManifest {
  const value = JSON.parse(raw) as ManualWaitpointCatalogManifest;
  if (
    value.version !== 1 ||
    typeof value.organizationId !== "string" ||
    typeof value.environmentId !== "string" ||
    typeof value.waitpointId !== "string" ||
    (value.idempotencyKey !== undefined && typeof value.idempotencyKey !== "string") ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string") ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(value.acceptUntil)
  )
    throw new Error("Invalid MANUAL waitpoint catalog manifest");
  return value;
}

export type ManualWaitpointCatalogListInput = {
  organizationId: string;
  environmentId: string;
  projectId?: string;
  id?: string;
  idempotencyKey?: string;
  tags?: string[];
  statuses?: ("PENDING" | "COMPLETED")[];
  outputIsError?: boolean;
  createdAtGte?: string;
  createdAtLte?: string;
  cursor?: string;
  direction: "forward" | "backward";
  limit: number;
};

type Options = {
  redis: RedisClient;
  beforeCommand?: () => Promise<void>;
  readRecords: (ids: string[]) => Promise<Map<string, WaitpointStoredRecord>>;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function base(organizationId: string, environmentId: string) {
  // Hash the tenant tuple so braces supplied in ids cannot change Redis's cluster tag.
  return `wp:v1:manual:{${digest(JSON.stringify([organizationId, environmentId]))}}`;
}

function datePrefix(iso: string) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid MANUAL catalog date filter");
  // Lexically ordered for the full JS Date range, including times before the epoch.
  return (BigInt(timestamp) + BigInt(MAX_DATE)).toString().padStart(17, "0");
}

function facets(manifest: ManualWaitpointCatalogManifest): { key: string; member: string }[] {
  const prefix = base(manifest.organizationId, manifest.environmentId);
  const member = manifest.waitpointId;
  return [
    { key: `${prefix}:ids`, member },
    { key: `${prefix}:created`, member: `${datePrefix(manifest.createdAt)}:${member}` },
    ...(manifest.idempotencyKey !== undefined
      ? [{ key: `${prefix}:key:${digest(manifest.idempotencyKey)}`, member }]
      : []),
    ...manifest.tags.map((tag) => ({ key: `${prefix}:tag:${digest(tag)}`, member })),
  ];
}

function statusFacets(manifest: ManualWaitpointCatalogManifest, status: string) {
  return {
    key: `${base(manifest.organizationId, manifest.environmentId)}:status:${status}`,
    member: manifest.waitpointId,
  };
}

/**
 * Candidate indexes only: every result is hydrated from authoritative source hashes. The caller
 * admits these operations through the org flag; this class neither opens a client nor starts work.
 * Completion publication and retirement MUST share the existing per-source completion lock.
 */
export class ManualWaitpointCatalog {
  constructor(private readonly options: Options) {}

  async #command<T>(command: () => Promise<T>): Promise<T> {
    await this.options.beforeCommand?.();
    return command();
  }

  async getManifest(organizationId: string, waitpointId: string) {
    const raw = await this.#command(() =>
      this.options.redis.hget(
        manualWaitpointCatalogManifestKey(organizationId, waitpointId),
        waitpointId
      )
    );
    if (raw === null) return undefined;
    const manifest = parseManualWaitpointCatalogManifest(raw);
    if (manifest.organizationId !== organizationId || manifest.waitpointId !== waitpointId)
      throw new Error("MANUAL catalog manifest ownership mismatch");
    return manifest;
  }

  /** Must precede EVERY catalog write and canonical source publication. Replay is idempotent. */
  async publish(record: WaitpointRecordInput, acceptUntil: number): Promise<void> {
    if (record.type !== "MANUAL" || !record.organizationId)
      throw new Error("MANUAL catalog publication requires organization ownership");
    const manifest: ManualWaitpointCatalogManifest = {
      version: 1,
      organizationId: record.organizationId,
      environmentId: record.environmentId,
      waitpointId: record.id,
      idempotencyKey: record.idempotencyKey,
      tags: [...new Set(record.tags)].sort(),
      createdAt: record.createdAt,
      acceptUntil,
    };
    const serialized = JSON.stringify(manifest);
    parseManualWaitpointCatalogManifest(serialized);
    const index = organizationPendingSourceIndexKey(
      record.organizationId,
      fanoutPartition(record.id)
    );
    const metadata = manualWaitpointCatalogManifestKey(record.organizationId, record.id);
    assertSingleSlot("publish MANUAL catalog manifest", [index, metadata]);
    await this.#command(() =>
      this.options.redis.eval(
        `local now = redis.call('TIME')
       if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= tonumber(ARGV[3]) then
         return redis.error_reply('MANUAL catalog publication fence closed')
       end
       local old = redis.call('HGET', KEYS[2], ARGV[1])
       if old and old ~= ARGV[2] then return redis.error_reply('MANUAL catalog manifest changed') end
       redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
       redis.call('ZADD', KEYS[1], 0, ARGV[1]); return 1`,
        2,
        index,
        metadata,
        record.id,
        serialized,
        String(acceptUntil)
      )
    );
    await this.#writeFacets([...facets(manifest), statusFacets(manifest, "PENDING")], acceptUntil);
  }

  async #writeFacets(entries: { key: string; member: string }[], acceptUntil?: number) {
    for (let offset = 0; offset < entries.length; offset += PAGE_SIZE) {
      const page = entries.slice(offset, offset + PAGE_SIZE);
      const keys = page.map((entry) => entry.key);
      assertSingleSlot("publish MANUAL catalog candidates", keys);
      const result = await this.#command(() =>
        this.options.redis.eval(
          `if ARGV[1] ~= '' then
           local now = redis.call('TIME')
           if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= tonumber(ARGV[1]) then return 0 end
         end
         for i = 1, #KEYS do redis.call('ZADD', KEYS[i], 0, ARGV[i + 1]) end; return 1`,
          keys.length,
          ...keys,
          acceptUntil === undefined ? "" : String(acceptUntil),
          ...page.map((entry) => entry.member)
        )
      );
      if (result !== 1) throw new Error("MANUAL catalog publication fence closed");
    }
  }

  /** Publish before the canonical completion flip; pending/losing candidates are hydration false positives. */
  async publishCompletedCandidate(record: WaitpointRecordInput, outputIsError: boolean) {
    if (!record.organizationId)
      throw new Error("MANUAL catalog completion requires organization ownership");
    const manifest = await this.getManifest(record.organizationId, record.id);
    if (!manifest || record.type !== "MANUAL") throw new Error("MANUAL catalog manifest missing");
    await this.#writeFacets([
      statusFacets(manifest, "COMPLETED"),
      statusFacets(manifest, outputIsError ? "error" : "success"),
    ]);
  }

  /** Under the source completion lock, repair candidates from canonical status after interruptions. */
  async reconcileStatus(record: WaitpointRecordInput): Promise<void> {
    if (record.type !== "MANUAL" || !record.organizationId)
      throw new Error("MANUAL catalog reconciliation requires organization ownership");
    const item = (await this.options.readRecords([record.id])).get(record.id);
    if (!item) return;
    if (
      item.record.organizationId !== record.organizationId ||
      item.record.environmentId !== record.environmentId
    )
      throw new Error("MANUAL catalog completion ownership mismatch");
    const manifest = await this.getManifest(record.organizationId, record.id);
    if (!manifest) throw new Error("MANUAL catalog manifest missing");
    const statuses = ["PENDING", "COMPLETED", "error", "success"];
    const entries = statuses.map((status) => statusFacets(manifest, status));
    const keys = entries.map((entry) => entry.key);
    assertSingleSlot("reconcile MANUAL catalog status", keys);
    const winner =
      item.status === "PENDING" ? "PENDING" : item.completion?.outputIsError ? "error" : "success";
    await this.#command(() =>
      this.options.redis.eval(
        `if ARGV[2] == 'PENDING' then
           redis.call('ZADD', KEYS[1], 0, ARGV[1])
           for i = 2, 4 do redis.call('ZREM', KEYS[i], ARGV[1]) end
         else
           redis.call('ZADD', KEYS[2], 0, ARGV[1])
           local winner = ARGV[2] == 'error' and 3 or 4
           redis.call('ZADD', KEYS[winner], 0, ARGV[1])
           redis.call('ZREM', KEYS[1], ARGV[1])
           redis.call('ZREM', KEYS[winner == 3 and 4 or 3], ARGV[1])
         end; return 1`,
        keys.length,
        ...keys,
        record.id,
        winner
      )
    );
  }

  /**
   * Under the source completion lock, AFTER the allocation fence closes. On any failed command the
   * manifest/owner remain discoverable. The caller retires org discovery LAST, respecting fanout and
   * receipt ownership too. All possible status facets are immutable cleanup targets.
   */
  async retire(manifest: ManualWaitpointCatalogManifest): Promise<boolean> {
    const time = await this.#command(() => this.options.redis.time());
    if (Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) <= manifest.acceptUntil)
      return false;
    if ((await this.options.readRecords([manifest.waitpointId])).has(manifest.waitpointId))
      return false;
    const entries = [
      ...facets(manifest),
      ...["PENDING", "COMPLETED", "error", "success"].map((status) =>
        statusFacets(manifest, status)
      ),
    ];
    for (let offset = 0; offset < entries.length; offset += PAGE_SIZE) {
      const page = entries.slice(offset, offset + PAGE_SIZE);
      const keys = page.map((entry) => entry.key);
      assertSingleSlot("retire MANUAL catalog candidates", keys);
      await this.#command(() =>
        this.options.redis.eval(
          `for i = 1, #KEYS do redis.call('ZREM', KEYS[i], ARGV[i]) end; return 1`,
          keys.length,
          ...keys,
          ...page.map((entry) => entry.member)
        )
      );
    }
    const result = await this.#command(() =>
      this.options.redis.eval(
        `local old = redis.call('HGET', KEYS[1], ARGV[1])
       if not old then return 1 end
       if old ~= ARGV[2] then return redis.error_reply('MANUAL catalog manifest changed') end
       redis.call('HDEL', KEYS[1], ARGV[1]); return 1`,
        1,
        manualWaitpointCatalogManifestKey(manifest.organizationId, manifest.waitpointId),
        manifest.waitpointId,
        JSON.stringify(manifest)
      )
    );
    return result === 1;
  }

  async list(input: ManualWaitpointCatalogListInput): Promise<WaitpointStoredRecord[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1)
      throw new Error("Invalid MANUAL catalog limit");
    const matches = (item: WaitpointStoredRecord) => {
      const record = item.record;
      const created = Date.parse(record.createdAt);
      return (
        record.type === "MANUAL" &&
        record.organizationId === input.organizationId &&
        record.environmentId === input.environmentId &&
        (!input.projectId || record.projectId === input.projectId) &&
        (!input.id || record.id === input.id) &&
        (input.idempotencyKey === undefined || record.idempotencyKey === input.idempotencyKey) &&
        (!input.tags?.length || input.tags.some((tag) => record.tags.includes(tag))) &&
        (!input.statuses?.length || input.statuses.includes(item.status)) &&
        (input.outputIsError === undefined ||
          (item.completion?.outputIsError ?? false) === input.outputIsError) &&
        (input.createdAtGte === undefined || created >= Date.parse(input.createdAtGte)) &&
        (input.createdAtLte === undefined || created <= Date.parse(input.createdAtLte)) &&
        (!input.cursor ||
          (input.direction === "forward" ? record.id < input.cursor : record.id > input.cursor))
      );
    };
    // Listing uses completion metadata only. Do not retain inline output across candidate pages.
    const metadataOnly = (item: WaitpointStoredRecord): WaitpointStoredRecord =>
      item.completion ? { ...item, completion: { ...item.completion, output: null } } : item;
    if (input.id) {
      const record = (await this.options.readRecords([input.id])).get(input.id);
      return record && matches(record) ? [metadataOnly(record)] : [];
    }
    const prefix = base(input.organizationId, input.environmentId);
    type Driver = { keys: string[]; date?: boolean; count: number };
    // Select a selective index, never scan the environment then apply a selective filter.
    const candidates: Omit<Driver, "count">[] = [];
    if (input.idempotencyKey !== undefined)
      candidates.push({ keys: [`${prefix}:key:${digest(input.idempotencyKey)}`] });
    if (input.tags?.length)
      candidates.push({
        keys: [...new Set(input.tags)].map((tag) => `${prefix}:tag:${digest(tag)}`),
      });
    const statuses = new Set(input.statuses);
    if (input.outputIsError === true) candidates.push({ keys: [`${prefix}:status:error`] });
    else if (input.outputIsError === false)
      candidates.push({
        keys: [
          ...(statuses.size === 0 || statuses.has("PENDING") ? [`${prefix}:status:PENDING`] : []),
          ...(statuses.size === 0 || statuses.has("COMPLETED") ? [`${prefix}:status:success`] : []),
        ],
      });
    else if (statuses.size === 1)
      candidates.push({ keys: [`${prefix}:status:${[...statuses][0]}`] });
    const dateMin = input.createdAtGte ? `[${datePrefix(input.createdAtGte)}:` : "-";
    const dateMax = input.createdAtLte ? `[${datePrefix(input.createdAtLte)}:\xff` : "+";
    if (input.createdAtGte !== undefined || input.createdAtLte !== undefined)
      candidates.push({ keys: [`${prefix}:created`], date: true });
    if (!candidates.length) candidates.push({ keys: [`${prefix}:ids`] });
    let driver: Driver | undefined;
    for (const candidate of candidates) {
      let count = 0;
      for (const key of candidate.keys)
        count += await this.#command(() =>
          candidate.date
            ? this.options.redis.zlexcount(key, dateMin, dateMax)
            : this.options.redis.zcard(key)
        );
      if (!driver || count < driver.count) driver = { ...candidate, count };
    }
    if (!driver || driver.count === 0) return [];
    const result = new Map<string, WaitpointStoredRecord>();
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    // Tags/status ORs are independent ordered streams. Each keeps only the best limit IDs; union
    // duplicates never occupy extra output slots. Date order differs from ID order, so that driver
    // visits the matching time window in bounded pages and retains only the best limit IDs.
    for (const key of driver.keys) {
      let boundary = driver.date
        ? dateMin
        : input.cursor
          ? `(${input.cursor}`
          : input.direction === "forward"
            ? "+"
            : "-";
      let streamMatches = 0;
      while (true) {
        const descending = !driver.date && input.direction === "forward";
        const members = await this.#command(() =>
          descending
            ? this.options.redis.zrevrangebylex(key, boundary, "-", "LIMIT", 0, PAGE_SIZE)
            : this.options.redis.zrangebylex(
                key,
                boundary,
                driver!.date ? dateMax : "+",
                "LIMIT",
                0,
                PAGE_SIZE
              )
        );
        if (!members.length) break;
        const ids = driver.date ? members.map((member) => member.slice(18)) : members;
        const records = await this.options.readRecords(ids);
        for (const id of ids) {
          const record = records.get(id);
          if (!record || !matches(record)) continue;
          streamMatches++;
          result.set(id, metadataOnly(record));
          if (result.size > input.limit) {
            const ordered = [...result.keys()].sort(compare);
            result.delete(
              input.direction === "forward" ? ordered[0]! : ordered[ordered.length - 1]!
            );
          }
        }
        if (members.length < PAGE_SIZE || (!driver.date && streamMatches >= input.limit)) break;
        boundary = `(${members[members.length - 1]}`;
      }
    }
    return [...result.values()].sort((a, b) =>
      input.direction === "forward"
        ? compare(b.record.id, a.record.id)
        : compare(a.record.id, b.record.id)
    );
  }
}
