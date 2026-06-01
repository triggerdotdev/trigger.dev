import {
  createRedisClient,
  type Callback,
  type Redis,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import { BufferEntry, BufferEntrySchema } from "./schemas.js";

export type MollifierBufferOptions = {
  redisOptions: RedisOptions;
  logger?: Logger;
};

// Grace TTL applied to the entry hash on drainer ack. The entry survives
// this long after materialisation so direct reads (retrieve, trace, etc.)
// have a safety net while PG replica lag settles.
const ACK_GRACE_TTL_SECONDS = 30;

// ioredis reconnect backoff for the mollifier buffer client. The base
// grows linearly with the attempt count and is capped at 1s (the same
// envelope as the previous fixed `Math.min(times * 50, 1000)` schedule).
// We then apply equal jitter — a uniform pick in `[base/2, base]` — so a
// fleet of webapp instances reconnecting after the same Redis blip don't
// retry in lockstep and stampede Redis on recovery (thundering herd).
// Because the jittered value never exceeds the original cap, this is never
// slower than before — just decorrelated. Mirrors the jittered-backoff
// approach the mutate-fallback wait loop adopted for the same reason.
export function mollifierReconnectDelayMs(
  times: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(times * 50, 1000);
  const half = Math.floor(base / 2);
  return half + Math.round(random() * (base - half));
}

export type SnapshotPatch =
  | { type: "append_tags"; tags: string[] }
  | { type: "set_metadata"; metadata: string; metadataType: string }
  | { type: "set_delay"; delayUntil: string }
  | { type: "mark_cancelled"; cancelledAt: string; cancelReason?: string };

export type MutateSnapshotResult = "applied_to_snapshot" | "not_found" | "busy";

export type CasSetMetadataResult =
  | { kind: "applied"; newVersion: number }
  | { kind: "version_conflict"; currentVersion: number }
  | { kind: "not_found" }
  | { kind: "busy" };

export type AcceptResult =
  | { kind: "accepted" }
  | { kind: "duplicate_run_id" }
  | { kind: "duplicate_idempotency"; existingRunId: string };

export type IdempotencyLookupInput = {
  envId: string;
  taskIdentifier: string;
  idempotencyKey: string;
};

// Reversible encoding for Redis-key segments. The composite-key builders
// concatenate `envId`, `taskIdentifier`, and `idempotencyKey` with `:`
// separators; if any segment contains a literal `:` (envId is internal
// and `:`-free, but taskIdentifier and idempotencyKey are
// customer-supplied) different tuples would map to the same Redis key
// and dedupe the wrong run. base64url has no `:` in its alphabet and is
// bijective on the input string, so the encoded keys are
// collision-free.
function encodeKeyPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

// Exported so tests can compute the same Redis key the buffer writes
// without hard-coding the encoding (which is a buffer-internal detail).
export function idempotencyLookupKeyFor(input: IdempotencyLookupInput): string {
  return `mollifier:idempotency:${encodeKeyPart(input.envId)}:${encodeKeyPart(input.taskIdentifier)}:${encodeKeyPart(input.idempotencyKey)}`;
}

// Pre-gate claim key namespace, distinct from `mollifier:idempotency` so the
// existing buffer-side dedup stays isolated. The claim is the
// authoritative cross-store "this idempotency key is in flight or
// resolved" pointer used by the trigger hot path. Values:
//   "pending:<token>"  → claimed by a trigger pipeline; `<token>` is the
//                        caller-supplied ownership token. Release and
//                        publish compare-and-act on this token so a
//                        late release from a previous claimant whose TTL
//                        expired cannot erase a new owner's claim.
//   <runId>            → the winning trigger's resolved runId.
const PENDING_PREFIX = "pending:";

// Exported (like `idempotencyLookupKeyFor`) so tests can target the same
// claim key the buffer writes without hard-coding the encoding.
export function makeIdempotencyClaimKey(input: IdempotencyLookupInput): string {
  return `mollifier:claim:${encodeKeyPart(input.envId)}:${encodeKeyPart(input.taskIdentifier)}:${encodeKeyPart(input.idempotencyKey)}`;
}

export type IdempotencyClaimResult =
  | { kind: "claimed" }
  | { kind: "pending" }
  | { kind: "resolved"; runId: string };

export class MollifierBuffer {
  private readonly redis: Redis;
  private readonly logger: Logger;

  constructor(options: MollifierBufferOptions) {
    this.logger = options.logger ?? new Logger("MollifierBuffer", "debug");

    this.redis = createRedisClient(
      {
        ...options.redisOptions,
        retryStrategy(times) {
          return mollifierReconnectDelayMs(times);
        },
        maxRetriesPerRequest: 20,
      },
      {
        onError: (error) => {
          this.logger.error("MollifierBuffer redis client error:", { error });
        },
      },
    );
    this.#registerCommands();
  }

  // Three outcomes:
  //   - { kind: "accepted" } — entry was newly written.
  //   - { kind: "duplicate_run_id" } — runId was already buffered (idempotent
  //     no-op, same semantic as the previous boolean-false return).
  //   - { kind: "duplicate_idempotency", existingRunId } — the (env, task,
  //     idempotencyKey) tuple was already bound to another buffered run.
  //     The Lua's atomic SETNX is the race-winner; the second caller gets
  //     the winner's runId so it can return that as the trigger response.
  async accept(input: {
    runId: string;
    envId: string;
    orgId: string;
    payload: string;
    // Optional idempotency-key triple. When all three are present we
    // SETNX a Redis lookup at `mollifier:idempotency:{env}:{task}:{key}`
    // pointing at the runId so trigger-time dedup during the buffered
    // window resolves the same way PG's unique constraint resolves it
    // post-materialisation.
    idempotencyKey?: string;
    taskIdentifier?: string;
  }): Promise<AcceptResult> {
    const entryKey = `mollifier:entries:${input.runId}`;
    const queueKey = `mollifier:queue:${input.envId}`;
    const orgsKey = "mollifier:orgs";
    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    // Microsecond epoch, stored as a hash field for dwell-time metrics
    // (stale sweep, drainer dwell span). FIFO ordering comes from the
    // LIST itself (LPUSH head / RPOP tail), not from this value — it is
    // no longer a queue sort key.
    const createdAtMicros = nowMs * 1000;
    const idempotencyLookupKey =
      input.idempotencyKey && input.taskIdentifier
        ? idempotencyLookupKeyFor({
            envId: input.envId,
            taskIdentifier: input.taskIdentifier,
            idempotencyKey: input.idempotencyKey,
          })
        : "";
    const result = await this.redis.acceptMollifierEntry(
      entryKey,
      queueKey,
      orgsKey,
      input.runId,
      input.envId,
      input.orgId,
      input.payload,
      createdAt,
      String(createdAtMicros),
      "mollifier:org-envs:",
      idempotencyLookupKey,
      "mollifier:entries:",
    );
    // Lua returns 1 (accepted), 0 (duplicate runId), or a string runId
    // (duplicate idempotency — value is the existing winner's runId).
    if (typeof result === "string" && result.length > 0) {
      return { kind: "duplicate_idempotency", existingRunId: result };
    }
    if (result === 1) return { kind: "accepted" };
    return { kind: "duplicate_run_id" };
  }

  async pop(envId: string): Promise<BufferEntry | null> {
    const queueKey = `mollifier:queue:${envId}`;
    const orgsKey = "mollifier:orgs";
    const entryPrefix = "mollifier:entries:";
    const encoded = (await this.redis.popAndMarkDraining(
      queueKey,
      orgsKey,
      entryPrefix,
      envId,
      "mollifier:org-envs:",
    )) as string | null;
    if (!encoded) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(encoded);
    } catch {
      this.logger.error("MollifierBuffer.pop: failed to parse script result", { envId });
      return null;
    }

    const parsed = BufferEntrySchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error("MollifierBuffer.pop: invalid entry shape", {
        envId,
        errors: parsed.error.flatten(),
      });
      return null;
    }
    return parsed.data;
  }

  async getEntry(runId: string): Promise<BufferEntry | null> {
    const raw = await this.redis.hgetall(`mollifier:entries:${runId}`);
    if (!raw || Object.keys(raw).length === 0) return null;

    const parsed = BufferEntrySchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error("MollifierBuffer.getEntry: invalid entry shape", {
        runId,
        errors: parsed.error.flatten(),
      });
      return null;
    }
    return parsed.data;
  }

  // Drainer walks these two methods to schedule pops with org-level
  // fairness: one env per org per tick. The Lua scripts maintain both
  // sets atomically with the per-env queues, so an org/env appears here
  // exactly when at least one of its envs has a queued entry.
  async listOrgs(): Promise<string[]> {
    return this.redis.smembers("mollifier:orgs");
  }

  async listEnvsForOrg(orgId: string): Promise<string[]> {
    return this.redis.smembers(`mollifier:org-envs:${orgId}`);
  }

  // Read-only enumeration of currently-queued entries for a single env.
  // Used by the stale-sweep to compute per-entry dwell time, so order is
  // immaterial — LRANGE returns them newest-first (LPUSH head) but the
  // caller scans the whole window. Non-destructive: the drainer still
  // RPOPs these entries in FIFO order.
  //
  // The entry HGETALLs are issued in a single pipelined batch (one
  // network round-trip instead of N) — at the stale-sweep's default
  // maxCount=1000 the serial implementation cost ~1000 RTTs per env,
  // which dominated sweep wall-time at any meaningful backlog.
  //
  // A missing entry (empty hash) is skipped: the drainer's RPOP+DEL of
  // the entry hash can race our LRANGE→HGETALL window, so a runId on
  // the queue with no backing hash is an expected concurrency outcome,
  // not an error.
  async listEntriesForEnv(envId: string, maxCount: number): Promise<BufferEntry[]> {
    if (maxCount <= 0) return [];
    const runIds = await this.redis.lrange(
      `mollifier:queue:${envId}`,
      0,
      maxCount - 1,
    );
    if (runIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const runId of runIds) {
      pipeline.hgetall(`mollifier:entries:${runId}`);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const entries: BufferEntry[] = [];
    for (let i = 0; i < results.length; i++) {
      const [err, raw] = results[i] as [Error | null, Record<string, string> | null];
      if (err) {
        this.logger.error("MollifierBuffer.listEntriesForEnv: hgetall failed", {
          runId: runIds[i],
          err: err.message,
        });
        continue;
      }
      if (!raw || Object.keys(raw).length === 0) continue;
      const parsed = BufferEntrySchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.error("MollifierBuffer.listEntriesForEnv: invalid entry shape", {
          runId: runIds[i],
          errors: parsed.error.flatten(),
        });
        continue;
      }
      entries.push(parsed.data);
    }
    return entries;
  }

  // Atomic snapshot mutation. Used by customer-mutation API endpoints
  // (tags, metadata-put, reschedule, cancel) when the run is still in
  // the buffer. Three outcomes:
  //   - "applied_to_snapshot": entry was QUEUED + not materialised; the
  //     drainer will read the patched payload on its next pop.
  //   - "not_found": no entry hash exists for this runId — including a
  //     FAILED entry, whose hash the drainer-terminal `fail` path DELs.
  //   - "busy": entry is DRAINING or materialised. The API
  //     wait-and-bounces through PG.
  async mutateSnapshot(runId: string, patch: SnapshotPatch): Promise<MutateSnapshotResult> {
    const result = (await this.redis.mutateMollifierSnapshot(
      `mollifier:entries:${runId}`,
      JSON.stringify(patch),
    )) as string;
    if (
      result === "applied_to_snapshot" ||
      result === "not_found" ||
      result === "busy"
    ) {
      return result;
    }
    throw new Error(`MollifierBuffer.mutateSnapshot: unexpected Lua return value: ${result}`);
  }

  // Optimistic compare-and-swap on the snapshot's metadata. Caller reads
  // the current metadataVersion via getEntry, applies operations in JS via
  // `applyMetadataOperations`, then calls this with the new metadata + the
  // expected version. Lua refuses if the version has moved (caller retries
  // up to N times). Mirrors the PG-side `UpdateMetadataService` retry
  // loop so concurrent increment/append operations don't lose deltas.
  async casSetMetadata(input: {
    runId: string;
    expectedVersion: number;
    newMetadata: string;
    newMetadataType: string;
  }): Promise<CasSetMetadataResult> {
    const entryKey = `mollifier:entries:${input.runId}`;
    const raw = (await this.redis.casSetMollifierMetadata(
      entryKey,
      String(input.expectedVersion),
      input.newMetadata,
      input.newMetadataType,
    )) as string;
    if (raw === "not_found") return { kind: "not_found" };
    if (raw === "busy") return { kind: "busy" };
    if (raw.startsWith("conflict:")) {
      return { kind: "version_conflict", currentVersion: Number(raw.slice("conflict:".length)) };
    }
    if (raw.startsWith("applied:")) {
      return { kind: "applied", newVersion: Number(raw.slice("applied:".length)) };
    }
    throw new Error(`MollifierBuffer.casSetMetadata: unexpected Lua return: ${raw}`);
  }

  // Atomic pre-gate claim on a (env, task, idempotencyKey) tuple. One
  // call across both PG and buffer paths serialises through this claim;
  // closes the race the buffer-side SETNX leaves open during the
  // gate-transition burst window.
  //
  // The caller supplies an opaque `token` (UUID) on claim. The same token
  // MUST be passed to `publishClaim` / `releaseClaim`, which compare-and-
  // act so a late release from a previous claimant whose TTL expired
  // cannot erase a new owner's claim.
  //
  // - "claimed": we now own the claim, the caller proceeds with the
  //   trigger pipeline and must `publishClaim` on success or
  //   `releaseClaim` on failure.
  // - "pending": another trigger owns the claim and hasn't published
  //   yet; the caller should poll.
  // - "resolved": the claim already holds a runId; the caller can
  //   return that runId as a cached hit.
  async claimIdempotency(
    input: IdempotencyLookupInput & { token: string; ttlSeconds: number },
  ): Promise<IdempotencyClaimResult> {
    const claimKey = makeIdempotencyClaimKey(input);
    const raw = (await this.redis.claimMollifierIdempotency(
      claimKey,
      `${PENDING_PREFIX}${input.token}`,
      PENDING_PREFIX,
      String(input.ttlSeconds),
    )) as string;
    if (raw === "claimed") return { kind: "claimed" };
    if (raw === "pending") return { kind: "pending" };
    if (raw.startsWith("resolved:")) {
      return { kind: "resolved", runId: raw.slice("resolved:".length) };
    }
    throw new Error(`MollifierBuffer.claimIdempotency: unexpected return: ${raw}`);
  }

  // Publish the winning runId to the claim so subsequent claimants /
  // waiters see "resolved". TTL bounded by the customer's
  // `idempotencyKeyExpiresAt` minus now; caller computes.
  //
  // Compare-and-set on the caller's token: if the current value isn't
  // our pending marker (TTL expired and another claimant moved in, or
  // someone else already published), the publish is a no-op. The caller
  // can treat any such case as "we lost the claim" and re-read.
  // Returns true if we published; false if the claim slot was no longer
  // ours.
  async publishClaim(
    input: IdempotencyLookupInput & { token: string; runId: string; ttlSeconds: number },
  ): Promise<boolean> {
    const claimKey = makeIdempotencyClaimKey(input);
    const result = (await this.redis.publishMollifierClaim(
      claimKey,
      `${PENDING_PREFIX}${input.token}`,
      input.runId,
      String(input.ttlSeconds),
    )) as number;
    return result === 1;
  }

  // Release the claim on pipeline error so waiters can re-claim and
  // retry. Idempotent.
  //
  // Compare-and-delete on the caller's token: only deletes if the
  // current value is exactly our pending marker. A late release from a
  // claimant whose TTL expired is a no-op, so a new owner's claim is
  // never wiped by a slow predecessor.
  async releaseClaim(input: IdempotencyLookupInput & { token: string }): Promise<void> {
    const claimKey = makeIdempotencyClaimKey(input);
    await this.redis.releaseMollifierClaim(
      claimKey,
      `${PENDING_PREFIX}${input.token}`,
    );
  }

  // Read the current claim value, used by the wait/poll loop on losers
  // to detect "pending" → "resolved" transitions and timeouts.
  async readClaim(input: IdempotencyLookupInput): Promise<IdempotencyClaimResult | null> {
    const claimKey = makeIdempotencyClaimKey(input);
    const value = await this.redis.get(claimKey);
    if (value === null) return null;
    if (value.startsWith(PENDING_PREFIX)) return { kind: "pending" };
    return { kind: "resolved", runId: value };
  }

  // Resolve a buffered run by (env, task, idempotencyKey) tuple. Used by
  // `IdempotencyKeyConcern.handleTriggerRequest` after the PG check
  // misses — same key may belong to a buffered run waiting to drain. The
  // lookup self-heals: if the lookup points at an entry hash that's gone,
  // we clear the lookup and report a miss. The clear is a compare-and-
  // delete (only if the key still holds the stale runId we observed) so a
  // fresh accept that rebinds the key between our GET and DEL isn't wiped.
  async lookupIdempotency(input: IdempotencyLookupInput): Promise<string | null> {
    const lookupKey = idempotencyLookupKeyFor(input);
    const runId = await this.redis.get(lookupKey);
    if (!runId) return null;
    const entry = await this.getEntry(runId);
    if (!entry) {
      await this.redis.delMollifierKeyIfEquals(lookupKey, runId);
      return null;
    }
    return runId;
  }

  // Clear the idempotency binding from a buffered run. Used by
  // `ResetIdempotencyKeyService` alongside the existing PG-side
  // `updateMany`. Returns the runId that was cleared, or null if no
  // buffered run held this key.
  async resetIdempotency(input: IdempotencyLookupInput): Promise<{ clearedRunId: string | null }> {
    const lookupKey = idempotencyLookupKeyFor(input);
    const claimKey = makeIdempotencyClaimKey(input);
    const clearedRunId = (await this.redis.resetMollifierIdempotency(
      lookupKey,
      "mollifier:entries:",
      claimKey,
    )) as string;
    return { clearedRunId: clearedRunId.length > 0 ? clearedRunId : null };
  }

  // Marks the entry as materialised (PG row written) and resets its TTL to
  // the grace window. Entry hash persists past ack as a read-fallback
  // safety net for the brief PG replica-lag window between drainer-side
  // write and reader-side visibility. Also clears the associated
  // idempotency lookup if one was set on accept.
  async ack(runId: string): Promise<void> {
    await this.redis.ackMollifierEntry(
      `mollifier:entries:${runId}`,
      String(ACK_GRACE_TTL_SECONDS),
    );
  }

  async requeue(runId: string): Promise<void> {
    await this.redis.requeueMollifierEntry(
      `mollifier:entries:${runId}`,
      "mollifier:orgs",
      "mollifier:queue:",
      runId,
      "mollifier:org-envs:",
    );
  }

  // Returns true if a live entry was torn down; false if the entry no
  // longer existed (a concurrent ack or manual cleanup removed it between
  // pop and fail — there is no accept-time TTL). Note FAILED is not an
  // observable state: the Lua marks the hash FAILED then DELs it in the
  // same atomic script, so a subsequent getEntry returns null. Caller can
  // use the boolean to skip downstream FAILED handling for ghost entries.
  async fail(runId: string, error: { code: string; message: string }): Promise<boolean> {
    const result = await this.redis.failMollifierEntry(
      `mollifier:entries:${runId}`,
      JSON.stringify(error),
    );
    return result === 1;
  }

  // Returns Redis-side TTL on the entry hash. Returns -1 for entries
  // with no TTL — the steady state under the current design, where
  // entries persist until drainer ack/fail. The ack grace TTL (30s
  // post-materialise) is the only context where this returns a
  // positive value; tests around the grace TTL still rely on it.
  async getEntryTtlSeconds(runId: string): Promise<number> {
    return this.redis.ttl(`mollifier:entries:${runId}`);
  }


  async evaluateTrip(
    envId: string,
    options: { windowMs: number; threshold: number; holdMs: number },
  ): Promise<{ tripped: boolean; count: number }> {
    const rateKey = `mollifier:rate:${envId}`;
    const trippedKey = `mollifier:tripped:${envId}`;
    const result = (await this.redis.mollifierEvaluateTrip(
      rateKey,
      trippedKey,
      String(options.windowMs),
      String(options.threshold),
      String(options.holdMs),
    )) as [number, number];

    return { count: result[0], tripped: result[1] === 1 };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  #registerCommands() {
    this.redis.defineCommand("acceptMollifierEntry", {
      numberOfKeys: 3,
      lua: `
        local entryKey = KEYS[1]
        local queueKey = KEYS[2]
        local orgsKey = KEYS[3]
        local runId = ARGV[1]
        local envId = ARGV[2]
        local orgId = ARGV[3]
        local payload = ARGV[4]
        local createdAt = ARGV[5]
        local createdAtMicros = ARGV[6]
        local orgEnvsPrefix = ARGV[7]
        local idempotencyLookupKey = ARGV[8] or ''
        local entryPrefix = ARGV[9]

        -- Idempotent: refuse if an entry for this runId already exists in any
        -- state. Caller-side dedup is also enforced via API idempotency keys,
        -- but the buffer must not double-enqueue if a caller retries.
        if redis.call('EXISTS', entryKey) == 1 then
          return 0
        end

        -- Idempotency-key dedup. If the caller passed a lookup key
        -- and it's already bound to another buffered run, return the
        -- winner's runId so the loser's API response can echo it as a
        -- cached hit. Otherwise SET the lookup (no TTL — lifecycle is
        -- paired with the entry hash; drainer ack/fail clear it
        -- explicitly).
        if idempotencyLookupKey ~= '' then
          local existing = redis.call('GET', idempotencyLookupKey)
          if existing then
            -- Self-heal: only honour the binding if its entry hash still
            -- exists. If the entry was evicted (maxmemory) but the lookup
            -- survived, the binding is stale — fall through and rebind to
            -- this run rather than returning a dead runId that would block
            -- the key indefinitely. Mirrors lookupIdempotency's self-heal.
            if redis.call('EXISTS', entryPrefix .. existing) == 1 then
              return existing
            end
          end
          redis.call('SET', idempotencyLookupKey, runId)
        end

        redis.call('HSET', entryKey,
          'runId', runId,
          'envId', envId,
          'orgId', orgId,
          'payload', payload,
          'status', 'QUEUED',
          'attempts', '0',
          'createdAt', createdAt,
          'createdAtMicros', createdAtMicros,
          'idempotencyLookupKey', idempotencyLookupKey,
          'metadataVersion', '0')
        -- No EXPIRE on the entry hash. Buffer entries persist until the
        -- drainer ACKs (post-materialise grace) or FAILs them — the
        -- drainer is the only recovery mechanism, so silent TTL-based
        -- eviction would lose runs with no customer-visible signal.
        -- Memory pressure from an offline drainer is the alertable
        -- failure mode instead; see _ops/mollifier-ops.md.
        -- LIST queue: LPUSH at the head, drainer RPOPs from the tail, so
        -- insertion order == drain order (FIFO). createdAtMicros is kept
        -- as a hash field for dwell metrics only — it is no longer a sort
        -- key now that the buffer has no list/pagination surface.
        redis.call('LPUSH', queueKey, runId)
        -- Org-level membership: maintained atomically with the per-env
        -- queue so the drainer can walk orgs → envs-for-org and
        -- schedule one env per org per tick. SADDs are idempotent if the
        -- org/env are already tracked.
        redis.call('SADD', orgsKey, orgId)
        redis.call('SADD', orgEnvsPrefix .. orgId, envId)
        return 1
      `,
    });

    this.redis.defineCommand("requeueMollifierEntry", {
      numberOfKeys: 2,
      lua: `
        local entryKey = KEYS[1]
        local orgsKey = KEYS[2]
        local queuePrefix = ARGV[1]
        local runId = ARGV[2]
        local orgEnvsPrefix = ARGV[3]

        local envId = redis.call('HGET', entryKey, 'envId')
        local orgId = redis.call('HGET', entryKey, 'orgId')
        if not envId then
          return 0
        end

        local currentAttempts = redis.call('HGET', entryKey, 'attempts')
        local nextAttempts = tonumber(currentAttempts or '0') + 1

        redis.call('HSET', entryKey, 'status', 'QUEUED', 'attempts', tostring(nextAttempts))
        -- Requeue RPUSHes to the tail (the RPOP end) so a transiently
        -- failed entry pops next rather than going to the back of the
        -- line behind a fresh backlog. createdAt is immutable across
        -- retries; the drainer's maxAttempts caps the
        -- retry loop so a poisoned entry doesn't head-of-line forever.
        redis.call('RPUSH', queuePrefix .. envId, runId)
        -- Re-track the org/env: pop may have SREM'd them when the queue
        -- last emptied. SADDs are idempotent if the values are still
        -- present.
        if orgId then
          redis.call('SADD', orgsKey, orgId)
          redis.call('SADD', orgEnvsPrefix .. orgId, envId)
        end
        return 1
      `,
    });

    this.redis.defineCommand("popAndMarkDraining", {
      numberOfKeys: 2,
      lua: `
        local queueKey = KEYS[1]
        local orgsKey = KEYS[2]
        local entryPrefix = ARGV[1]
        local envId = ARGV[2]
        local orgEnvsPrefix = ARGV[3]

        -- Helper: prune org-level membership when an env's queue empties.
        -- Called only from the success branch where we know orgId from the
        -- popped entry. The no-runId branch below can't reach this because
        -- it has no entry to read orgId from — accept any stale org-envs
        -- entries that result (bounded by env count, recovered next accept).
        local function pruneOrgMembership(orgId)
          if not orgId then return end
          local orgEnvsKey = orgEnvsPrefix .. orgId
          redis.call('SREM', orgEnvsKey, envId)
          if redis.call('SCARD', orgEnvsKey) == 0 then
            redis.call('SREM', orgsKey, orgId)
          end
        end

        -- Loop to skip orphan queue references — runIds whose entry hash is
        -- gone (e.g. Redis maxmemory eviction, since QUEUED entries carry
        -- no TTL of their own). HSET on a missing key would CREATE a
        -- partial hash without a TTL, leaking memory. The loop is bounded
        -- by queue length; entire Lua script remains atomic.
        while true do
          -- RPOP returns the tail member (oldest, FIFO), or false when empty.
          local runId = redis.call('RPOP', queueKey)
          if not runId then
            -- Queue is empty AND we have no entry to read orgId from, so
            -- skip org-level cleanup. Stale org-envs entries are bounded
            -- by env count and recovered on the next accept.
            return nil
          end

          local entryKey = entryPrefix .. runId
          if redis.call('EXISTS', entryKey) == 1 then
            redis.call('HSET', entryKey, 'status', 'DRAINING')
            local raw = redis.call('HGETALL', entryKey)
            local result = {}
            for i = 1, #raw, 2 do
              result[raw[i]] = raw[i + 1]
            end
            -- Prune org-level membership if this pop drained the queue.
            -- Atomic with the RPOP above — a concurrent accept AFTER
            -- this script will SADD both back along with its LPUSH.
            if redis.call('LLEN', queueKey) == 0 then
              pruneOrgMembership(result['orgId'])
            end
            return cjson.encode(result)
          end
          -- Orphan queue reference: entry hash gone (evicted) while runId
          -- was queued. Discard the reference and loop to the next.
        end
      `,
    });

    this.redis.defineCommand("casSetMollifierMetadata", {
      numberOfKeys: 1,
      lua: `
        local entryKey = KEYS[1]
        local expectedVersion = tonumber(ARGV[1])
        local newMetadata = ARGV[2]
        local newMetadataType = ARGV[3]

        if redis.call('EXISTS', entryKey) == 0 then
          return 'not_found'
        end

        local status = redis.call('HGET', entryKey, 'status')
        local materialised = redis.call('HGET', entryKey, 'materialised')
        if status ~= 'QUEUED' or materialised == 'true' then
          return 'busy'
        end

        local currentVersionStr = redis.call('HGET', entryKey, 'metadataVersion') or '0'
        local currentVersion = tonumber(currentVersionStr) or 0
        if currentVersion ~= expectedVersion then
          return 'conflict:' .. tostring(currentVersion)
        end

        -- Write the new metadata onto the snapshot's payload JSON. We
        -- keep the rest of the payload intact — only metadata/metadataType
        -- change. metadataVersion is denormalised on the hash for cheap
        -- CAS reads; it's intentionally NOT stored inside the payload
        -- itself (PG-side metadataVersion is a column, not a JSON field).
        local payloadJson = redis.call('HGET', entryKey, 'payload')
        local ok, payload = pcall(cjson.decode, payloadJson)
        if not ok then return 'busy' end
        payload.metadata = newMetadata
        payload.metadataType = newMetadataType

        local newVersion = currentVersion + 1
        redis.call('HSET', entryKey,
          'payload', cjson.encode(payload),
          'metadataVersion', tostring(newVersion))
        return 'applied:' .. tostring(newVersion)
      `,
    });

    this.redis.defineCommand("claimMollifierIdempotency", {
      numberOfKeys: 1,
      lua: `
        local claimKey = KEYS[1]
        local pendingMarker = ARGV[1]   -- "pending:<caller-token>"
        local pendingPrefix = ARGV[2]   -- "pending:"
        local ttl = tonumber(ARGV[3])

        -- SETNX-with-TTL: atomic; only one caller can win.
        local won = redis.call('SET', claimKey, pendingMarker, 'NX', 'EX', ttl)
        if won then
          return 'claimed'
        end

        local existing = redis.call('GET', claimKey)
        if not existing then
          -- The slot expired in the race window between the SET NX
          -- failing and this GET. It's free now — claim it so we don't
          -- string.sub a nil and error out.
          redis.call('SET', claimKey, pendingMarker, 'EX', ttl)
          return 'claimed'
        end
        -- Any "pending:*" value is a live claim — the caller-supplied
        -- token differentiates ownership but is opaque to losers.
        if string.sub(existing, 1, string.len(pendingPrefix)) == pendingPrefix then
          return 'pending'
        end
        return 'resolved:' .. existing
      `,
    });

    // Publish a winning runId to a claim slot we own. Compare-and-set on
    // the caller's pending marker: if the slot is no longer ours (TTL
    // expired and another claimant moved in, or already resolved by
    // someone else), we no-op. Returns 1 on publish, 0 on no-op.
    this.redis.defineCommand("publishMollifierClaim", {
      numberOfKeys: 1,
      lua: `
        local claimKey = KEYS[1]
        local ownerMarker = ARGV[1]   -- "pending:<our-token>"
        local runId = ARGV[2]
        local ttl = tonumber(ARGV[3])

        local existing = redis.call('GET', claimKey)
        if existing == ownerMarker then
          redis.call('SET', claimKey, runId, 'EX', ttl)
          return 1
        end
        return 0
      `,
    });

    // Release a claim slot we own. Compare-and-delete on the caller's
    // pending marker: a late release from a previous claimant whose TTL
    // expired is a no-op, so a new owner's claim is never wiped.
    this.redis.defineCommand("releaseMollifierClaim", {
      numberOfKeys: 1,
      lua: `
        local claimKey = KEYS[1]
        local ownerMarker = ARGV[1]   -- "pending:<our-token>"

        local existing = redis.call('GET', claimKey)
        if existing == ownerMarker then
          redis.call('DEL', claimKey)
          return 1
        end
        return 0
      `,
    });

    this.redis.defineCommand("resetMollifierIdempotency", {
      numberOfKeys: 1,
      lua: `
        local lookupKey = KEYS[1]
        local entryPrefix = ARGV[1]
        local claimKey = ARGV[2]

        -- Reset reopens the key across BOTH the buffer lookup and the
        -- cross-store pre-gate claim pointer. Without clearing the claim,
        -- a resolved/pending claim would keep deduping new triggers for
        -- the rest of its TTL even though the binding was reset. DEL is
        -- unconditional — the claim is gone regardless of whether a
        -- buffered run currently holds the lookup.
        redis.call('DEL', claimKey)

        local runId = redis.call('GET', lookupKey)
        if not runId then
          return ''
        end

        local entryKey = entryPrefix .. runId
        if redis.call('EXISTS', entryKey) == 0 then
          -- Stale lookup. Lazy cleanup.
          redis.call('DEL', lookupKey)
          return ''
        end

        -- Clear the idempotency fields on the snapshot payload so the
        -- drainer's eventual engine.trigger call inserts a PG row
        -- without the key set.
        local payloadJson = redis.call('HGET', entryKey, 'payload')
        if payloadJson then
          local ok, payload = pcall(cjson.decode, payloadJson)
          if ok then
            payload.idempotencyKey = cjson.null
            payload.idempotencyKeyExpiresAt = cjson.null
            redis.call('HSET', entryKey, 'payload', cjson.encode(payload))
          end
        end
        -- Clear the denormalised lookup pointer on the hash so a later
        -- ack doesn't try to DEL a key that's already gone.
        redis.call('HSET', entryKey, 'idempotencyLookupKey', '')
        redis.call('DEL', lookupKey)
        return runId
      `,
    });

    this.redis.defineCommand("mutateMollifierSnapshot", {
      numberOfKeys: 1,
      lua: `
        local entryKey = KEYS[1]
        local patchJson = ARGV[1]

        if redis.call('EXISTS', entryKey) == 0 then
          return 'not_found'
        end

        local status = redis.call('HGET', entryKey, 'status')
        local materialised = redis.call('HGET', entryKey, 'materialised')
        if status ~= 'QUEUED' or materialised == 'true' then
          return 'busy'
        end

        local payloadJson = redis.call('HGET', entryKey, 'payload')
        local ok, payload = pcall(cjson.decode, payloadJson)
        if not ok then return 'busy' end

        local patch = cjson.decode(patchJson)

        if patch.type == 'append_tags' then
          -- cjson decode of an absent or empty-array field gives nil or
          -- an empty table; we rebuild as a dense array. Existing tags
          -- are preserved; new tags are appended only if not present.
          local existing = payload.tags or {}
          local seen = {}
          local merged = {}
          for _, t in ipairs(existing) do
            if not seen[t] then
              seen[t] = true
              table.insert(merged, t)
            end
          end
          for _, t in ipairs(patch.tags or {}) do
            if not seen[t] then
              seen[t] = true
              table.insert(merged, t)
            end
          end
          payload.tags = merged
        elseif patch.type == 'set_metadata' then
          payload.metadata = patch.metadata
          payload.metadataType = patch.metadataType
          -- Bump the denormalised metadataVersion so an in-flight
          -- casSetMetadata (optimistic CAS keyed on this counter) sees
          -- the concurrent write as a version conflict and retries,
          -- instead of clobbering it under a now-stale expectedVersion.
          local currentVersion = tonumber(redis.call('HGET', entryKey, 'metadataVersion') or '0') or 0
          redis.call('HSET', entryKey, 'metadataVersion', tostring(currentVersion + 1))
        elseif patch.type == 'set_delay' then
          payload.delayUntil = patch.delayUntil
        elseif patch.type == 'mark_cancelled' then
          payload.cancelledAt = patch.cancelledAt
          payload.cancelReason = patch.cancelReason
        else
          return 'busy'
        end

        redis.call('HSET', entryKey, 'payload', cjson.encode(payload))
        return 'applied_to_snapshot'
      `,
    });

    this.redis.defineCommand("ackMollifierEntry", {
      numberOfKeys: 1,
      lua: `
        local entryKey = KEYS[1]
        local graceTtlSeconds = tonumber(ARGV[1])

        -- Guard: never create a partial entry. If the hash is gone between
        -- pop and ack (concurrent fail or eviction — QUEUED entries carry
        -- no TTL), the run is gone, nothing to mark materialised.
        if redis.call('EXISTS', entryKey) == 0 then
          return 0
        end

        -- If the entry was accepted with an idempotency key, the lookup
        -- string was stored on the hash at accept time. Clear it now —
        -- PG becomes canonical for the key post-materialisation.
        local lookupKey = redis.call('HGET', entryKey, 'idempotencyLookupKey')
        if lookupKey and lookupKey ~= '' then
          redis.call('DEL', lookupKey)
        end

        redis.call('HSET', entryKey, 'materialised', 'true')
        redis.call('EXPIRE', entryKey, graceTtlSeconds)
        return 1
      `,
    });

    this.redis.defineCommand("failMollifierEntry", {
      numberOfKeys: 1,
      lua: `
        local entryKey = KEYS[1]
        local errorPayload = ARGV[1]

        -- Guard: nothing to mark FAILED if the hash is gone (concurrent
        -- ack/manual cleanup). Returning 0 lets the caller distinguish
        -- "marked failed" from "no-op".
        if redis.call('EXISTS', entryKey) == 0 then
          return 0
        end

        redis.call('HSET', entryKey, 'status', 'FAILED', 'lastError', errorPayload)

        -- The drainer has already written a SYSTEM_FAILURE PG row for
        -- terminal failures (see mollifierDrainerHandler.server.ts), so
        -- the buffer entry is no longer load-bearing. Clear the
        -- idempotency lookup — PG's unique constraint is the canonical
        -- dedup mechanism post-materialise — and drop the entry hash so
        -- failed runs don't accrete forever now that there's no
        -- accept-time TTL.
        local lookupKey = redis.call('HGET', entryKey, 'idempotencyLookupKey')
        if lookupKey and lookupKey ~= '' then
          redis.call('DEL', lookupKey)
        end
        redis.call('DEL', entryKey)
        return 1
      `,
    });

    // Compare-and-delete: DEL the key only if it still holds the expected
    // value. Used by lookupIdempotency's stale-lookup self-heal so a
    // concurrent accept that rebinds the key between the reader's GET and
    // this DEL isn't clobbered.
    this.redis.defineCommand("delMollifierKeyIfEquals", {
      numberOfKeys: 1,
      lua: `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
    });

    this.redis.defineCommand("mollifierEvaluateTrip", {
      numberOfKeys: 2,
      lua: `
        local rateKey = KEYS[1]
        local trippedKey = KEYS[2]
        local windowMs = tonumber(ARGV[1])
        local threshold = tonumber(ARGV[2])
        local holdMs = tonumber(ARGV[3])

        local count = redis.call('INCR', rateKey)
        if count == 1 then
          redis.call('PEXPIRE', rateKey, windowMs)
        end

        if count > threshold then
          redis.call('PSETEX', trippedKey, holdMs, '1')
        end

        local tripped = redis.call('EXISTS', trippedKey)
        return {count, tripped}
      `,
    });
  }
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    acceptMollifierEntry(
      entryKey: string,
      queueKey: string,
      orgsKey: string,
      runId: string,
      envId: string,
      orgId: string,
      payload: string,
      createdAt: string,
      createdAtMicros: string,
      orgEnvsPrefix: string,
      idempotencyLookupKey: string,
      entryPrefix: string,
      callback?: Callback<number | string>,
    ): Result<number | string, Context>;
    popAndMarkDraining(
      queueKey: string,
      orgsKey: string,
      entryPrefix: string,
      envId: string,
      orgEnvsPrefix: string,
      callback?: Callback<string | null>,
    ): Result<string | null, Context>;
    requeueMollifierEntry(
      entryKey: string,
      orgsKey: string,
      queuePrefix: string,
      runId: string,
      orgEnvsPrefix: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    mutateMollifierSnapshot(
      entryKey: string,
      patchJson: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
    casSetMollifierMetadata(
      entryKey: string,
      expectedVersion: string,
      newMetadata: string,
      newMetadataType: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
    resetMollifierIdempotency(
      lookupKey: string,
      entryPrefix: string,
      claimKey: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
    claimMollifierIdempotency(
      claimKey: string,
      pendingMarker: string,
      pendingPrefix: string,
      ttlSeconds: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
    publishMollifierClaim(
      claimKey: string,
      ownerMarker: string,
      runId: string,
      ttlSeconds: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    releaseMollifierClaim(
      claimKey: string,
      ownerMarker: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    ackMollifierEntry(
      entryKey: string,
      graceTtlSeconds: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    failMollifierEntry(
      entryKey: string,
      errorPayload: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    delMollifierKeyIfEquals(
      key: string,
      expected: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    mollifierEvaluateTrip(
      rateKey: string,
      trippedKey: string,
      windowMs: string,
      threshold: string,
      holdMs: string,
      callback?: Callback<[number, number]>,
    ): Result<[number, number], Context>;
  }
}
