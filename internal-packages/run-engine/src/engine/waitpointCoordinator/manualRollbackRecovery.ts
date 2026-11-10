import { timeoutError } from "@trigger.dev/core/v3";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import {
  manualWaitpointCatalogManifestKey,
  parseManualWaitpointCatalogManifest,
} from "./manualWaitpointCatalog.js";
import { isDeepStrictEqual } from "node:util";
import type { RedisClient } from "@internal/redis";
import { hasStoreWaitpoints, type RunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { z } from "zod";
import { isFinalRunStatus } from "../statuses.js";
import {
  assertSingleSlot,
  runBlockKeys,
  runResultKey,
  runWithdrawalKey,
  runWithdrawalTargetsKey,
  runContributionKey,
  runContributionIndexKey,
  runWithdrawalIndexKey,
  organizationRunIndexKey,
  organizationPendingSourceIndexKey,
  organizationSourceReceiptKey,
  candidateMintFenceKey,
  FANOUT_PARTITION_COUNT,
  waitpointKeys,
  waitpointRelatedRunsKey,
  fanoutIndexKeys,
  fanoutPartition,
  parseEdgeField,
} from "./keys.js";
import { RUN_CLEANUP_PAGE_SIZE } from "./scripts.js";
import {
  DEFAULT_TERMINAL_RETENTION_MS,
  type WaitpointStoreCoordinator,
} from "./storeCoordinator.js";

export const recoveryOperationSchema = z.enum(["rollback", "contributions-only"]);
type RecoveryOperation = z.infer<typeof recoveryOperationSchema>;

const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const rollbackScopeSchema = z
  .object({
    organizationId: identity,
    runs: z
      .array(
        z
          .object({
            runId: identity,
            blockIds: z.array(identity).max(20).default([]),
            sourceIds: z.array(identity).max(10000).optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict();
type Scope = z.infer<typeof rollbackScopeSchema>;

const nativeSchema = z
  .object({
    identity: z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]),
    keys: z.array(z.object({ name: z.string(), count: z.number(), ttlMs: z.number() }).strict()),
    withdrawals: z.array(
      z.object({ blockId: identity, present: z.boolean(), targets: z.number() }).strict()
    ),
  })
  .strict();
type NativeState = z.infer<typeof nativeSchema>;
const runSchema = z
  .object({
    id: identity,
    organizationId: z.string().nullable(),
    runtimeEnvironmentId: identity,
    status: z.string(),
    updatedAt: z.string(),
    waitpointsOnStore: z.boolean(),
  })
  .strict();
const sourceSchema = z
  .object({
    waitpointId: identity,
    record: z.string(),
    completionId: z.string(),
    pendingRegistryOwned: z.boolean().optional(),
    catalogMetadata: z.string().optional(),
    receiptMetadata: z.string().optional(),
    receiptValue: z.string().nullable().optional(),
    status: z.enum(["PENDING", "COMPLETED"]),
  })
  .strict();
const receiptMetadataSchema = z
  .object({ key: z.string().min(1), acceptUntil: z.number().finite() })
  .strict();
const entrySchema = z
  .object({
    runId: identity,
    blockIds: z.array(identity).max(120),
    sources: z.array(sourceSchema).default([]),
    run: runSchema.nullable(),
    native: nativeSchema.nullable(),
    classification: z.enum([
      "terminal",
      "pending",
      "active-requires-cancellation",
      "legacy",
      "unknown",
      "abandoned-registry-owned",
    ]),
    registryOwned: z.boolean().default(false),
    eligible: z.boolean(),
    reason: z.string(),
  })
  .strict();
export const rollbackPlanSchema = z
  .object({
    version: z.literal(1),
    operation: recoveryOperationSchema.default("rollback"),
    target: z.string(),
    organizationId: identity,
    inspectedAt: z.string(),
    expiresAt: z.string(),
    entries: z.array(entrySchema).max(100),
    sources: z.array(sourceSchema).max(100).default([]),
    discovery: z.boolean().default(false),
    coverage: z.enum([
      "supplied run partitions, indexed contributions and named withdrawal blocks only",
      "indexed contributions of supplied terminal runs only",
      "bounded organization registry and completed-source discovery page",
    ]),
    unhandled: z.array(z.string()),
  })
  .strict();
export type RollbackPlan = z.infer<typeof rollbackPlanSchema>;

const UNHANDLED = [
  "This explicit scope plan covers only supplied runs; use organization registry discovery for omitted admitted runs and sources.",
  "Sources absent from this run scope require organization source registry or due/quarantine discovery, or incident source IDs for older unindexed state. Preserve source identities when renewing an expired plan.",
  "Detached withdrawals are included through each supplied run withdrawal index; historical unindexed blocks still need supplied IDs or a current blk/co reference.",
  "Supplied-run inspection previews at most 128 detached withdrawal targets per run. Remaining unreviewed sources stop apply; preserve the previous source list and inspect again with additional explicit source IDs, or use organization discovery.",
  "Native sources not named in the saved plan, untracked historical mint fences/receipt identities, and legacy rows are outside this tool's cleanup and verification scope.",
];

const REGISTRATION_HOLD =
  "registration hold remains: a parent's prepared registration still reads this source, so no retention was armed. The hold cannot name its run; find candidate parents with organization run discovery, cancel a live holder through the normal lifecycle, then select the terminal or abandoned holder (its contribution cleanup releases the hold), then inspect and apply this source again";

/** Atomic seek by (score, binary member), immune to other organizations changing earlier ranks. */
export const READ_INDEX_PAGE = `
  local function bytesLess(a,b)
    local n = math.min(string.len(a),string.len(b))
    for i=1,n do
      local x,y = string.byte(a,i),string.byte(b,i)
      if x ~= y then return x < y end
    end
    return string.len(a) < string.len(b)
  end
  local lo,hi = 0,redis.call('ZCARD',KEYS[1])
  if ARGV[1] ~= '' then
    local score = tonumber(ARGV[1])
    if not score then return redis.error_reply('Invalid discovery score') end
    for i=1,64 do
      if lo >= hi then break end
      local mid = math.floor(lo+(hi-lo)/2)
      local pair = redis.call('ZRANGE',KEYS[1],mid,mid,'WITHSCORES')
      local s = tonumber(pair[2])
      if s < score or (s == score and not bytesLess(ARGV[2],pair[1])) then lo=mid+1 else hi=mid end
    end
    if lo < hi then return redis.error_reply('Discovery lower bound did not converge') end
  end
  return redis.call('ZRANGE',KEYS[1],lo,lo+99,'WITHSCORES')
`;

// Fixed-size read-only script. No readBlockState/read repair, payload loading, SCAN or key enumeration.
const READ_NATIVE = `
  local names = {'state','pending','done','edges','refs','edgeIndex','doneOrder','early','earlyOrder','results','contributions'}
  local types = {'hash','set','hash','hash','hash','zset','zset','hash','zset','hash','zset'}
  local out = { identity = {}, keys = {}, withdrawals = {} }
  local fields = redis.call('HMGET', KEYS[1], 'rev','seq','blk','co','term')
  for i=1,5 do out.identity[i] = fields[i] or '' end
  for i=1,11 do
    local kind = redis.call('TYPE',KEYS[i]).ok
    if kind ~= 'none' and kind ~= types[i] then return redis.error_reply('Unknown native key type: '..names[i]) end
    local count = 0
    if kind == 'hash' then count = redis.call('HLEN',KEYS[i])
    elseif kind == 'set' then count = redis.call('SCARD',KEYS[i])
    elseif kind == 'zset' then count = redis.call('ZCARD',KEYS[i]) end
    out.keys[i] = {name=names[i],count=count,ttlMs=redis.call('PTTL',KEYS[i])}
  end
  for i=1,#ARGV do
    local wd, targets = KEYS[10+i*2], KEYS[11+i*2]
    local kind = redis.call('TYPE',targets).ok
    if kind ~= 'none' and kind ~= 'hash' then return redis.error_reply('Unknown withdrawal target type') end
    local value = redis.call('GET',wd)
    if value and value ~= ARGV[i] then return redis.error_reply('Invalid withdrawal identity') end
    if not value and kind ~= 'none' then return redis.error_reply('Withdrawal targets without manifest') end
    out.withdrawals[i]={blockId=ARGV[i],present=value ~= false,targets=redis.call('HLEN',targets)}
  end
  -- Empty Lua tables encode as objects; return arrays explicitly through the caller's normalization.
  return cjson.encode(out)
`;

// Read one source slot atomically: Redis freezes expiry time during a script, so matching
// finite TTLs cannot drift between reads. Missing history is valid for RUN/unsubscribed sources.
const READ_SOURCE_VERIFICATION = `
  local fields = redis.call('HMGET',KEYS[1],'r','status','cid','ku','ka','c')
  local sourceTtl, relatedTtl = redis.call('PTTL',KEYS[1]), redis.call('PTTL',KEYS[5])
  local absent = redis.call('EXISTS',unpack(KEYS)) == 0
  local held = (tonumber(redis.call('HGET',KEYS[1],'rh')) or 0) > 0
  local compatible = relatedTtl == -2 or
    (sourceTtl >= 0 and relatedTtl == sourceTtl) or
    (sourceTtl == -1 and relatedTtl == -1)
  local cleared = redis.call('EXISTS',KEYS[2],KEYS[3],KEYS[4]) == 0
  local retained = ((sourceTtl > 0 and not held) or
    (sourceTtl == -1 and ((fields[4] == '-1' and not held) or (fields[5] ~= false and not held)))) and compatible
    and cleared
  fields[7], fields[8], fields[9], fields[10] = absent and 1 or 0, retained and 1 or 0, sourceTtl, (sourceTtl == -1 and compatible and cleared and not held) and 1 or 0
  return fields
`;

// One declared, same-slot page. Exact generation checks precede every deletion. The caller has
// revalidated terminal primary ownership and quiesced producers. Contribution-only cleanup
// does not withdraw watchers or change a surviving native block/fence.
const RETIRE_CONTRIBUTIONS = `
  local state = redis.call('HMGET', KEYS[1], 'rev','seq','blk','co','term')
  for i=1,5 do
    if (state[i] or '') ~= ARGV[i] then return redis.error_reply('Rollback contribution state changed; inspect again') end
  end
  if ARGV[6] == 'rollback' and ((state[3] or '') ~= '' or (state[4] or '') ~= '') then
    return redis.error_reply('Rollback contribution cleanup requires completed withdrawal')
  end
  local count = #KEYS - 2
  if count > ${RUN_CLEANUP_PAGE_SIZE} or #ARGV ~= count + 6 then
    return redis.error_reply('Rollback contribution page is invalid')
  end
  for i=1,count do
    redis.call('UNLINK', KEYS[i+2])
    redis.call('ZREM', KEYS[2], ARGV[i+6])
  end
  return count
`;

// Seal an unpublished attempt BEFORE touching its candidate slot. Redis time, not the
// inspection's saved receipt or the operator host's clock, decides when publication closes.
const FENCE_SOURCE_RECEIPT = `
  local value = redis.call('GET',KEYS[1])
  if not value or value == 'pending' then
    local time = redis.call('TIME')
    local nowMs = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
    if nowMs <= tonumber(ARGV[1]) then return 'pending' end
    if not value then return '' end
    redis.call('SET',KEYS[1],'cancelled')
    return 'cancelled'
  end
  return value
`;

// One source slot, constant work. The reviewed immutable record/cid fence ownership and
// completion. No new watcher can register once COMPLETED. UNLINK avoids queue-size work.
const RETIRE_SOURCE = `
  local record, watchers, queue, fanout = unpack(KEYS)
  if redis.call('EXISTS', record) == 0 then
    if redis.call('EXISTS', watchers, queue, fanout) ~= 0 then return 'unknown' end
    if ARGV[8] ~= '' then
      local time = redis.call('TIME')
      local nowMs = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
      redis.call('SET',KEYS[5],'closed','PX',math.max(tonumber(ARGV[4]),tonumber(ARGV[8])-nowMs+tonumber(ARGV[4])),'NX')
    end
    redis.call('UNLINK', KEYS[6])
    return 'absent'
  end
  if redis.call('HGET', record, 'r') ~= ARGV[1]
    or (redis.call('HGET', record, 'cid') or '') ~= ARGV[2] then return 'changed' end
  local status = redis.call('HGET', record, 'status')
  local replay = ARGV[5] == 'datetime' and status == 'COMPLETED'
    and redis.call('HGET',record,'c') == ARGV[6]
  if status ~= ARGV[3] and not replay then return 'changed' end
  if redis.call('HLEN', watchers) ~= 0 then return 'live-watchers' end
  -- A prepared parent registration still reads this source. Arm no retention and retire
  -- nothing; only the deadline's own completion proceeds. Release applies ordinary retention:
  -- a non-keyed completed record gets a TTL, but a keyed one (ka) stays permanent until rerun.
  if (tonumber(redis.call('HGET', record, 'rh')) or 0) > 0 then
    if status == 'PENDING' and ARGV[5] == 'datetime' then
      redis.call('HSET',record,'status','COMPLETED','c',ARGV[6],'cid','','cAt',ARGV[7])
      redis.call('UNLINK', watchers, queue, fanout)
    end
    return 'held'
  end
  if status == 'PENDING' then
    if ARGV[5] == 'discard-candidate' then
      local time = redis.call('TIME')
      local nowMs = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
      redis.call('SET',KEYS[5],'closed','PX',math.max(tonumber(ARGV[4]),tonumber(ARGV[8])-nowMs+tonumber(ARGV[4])),'NX')
      redis.call('UNLINK',record,watchers,queue,fanout,KEYS[6])
      return 'absent'
    elseif ARGV[5] == 'finite' then
      if redis.call('PTTL',record) < 0 then return 'changed' end
      if ARGV[8] ~= '' then
        local time = redis.call('TIME')
        local nowMs = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
        redis.call('SET',KEYS[5],'closed','PX',math.max(tonumber(ARGV[4]),tonumber(ARGV[8])-nowMs+tonumber(ARGV[4])),'NX')
      end
      redis.call('PEXPIRE', KEYS[6], redis.call('PTTL',record))
      redis.call('UNLINK', watchers, queue, fanout)
      return 'retained'
    elseif ARGV[5] == 'pending-manual' then
      -- Allocation is fenced; a valid pending token keeps its own lifetime and catalog.
      redis.call('HDEL',record,'ka')
      redis.call('PERSIST',record)
      redis.call('PERSIST',KEYS[6])
      redis.call('UNLINK',watchers,queue,fanout)
      return 'retained'
    elseif ARGV[5] == 'datetime' then
      -- The deadline's normal empty completion, fenced by the reviewed immutable record.
      redis.call('HSET',record,'status','COMPLETED','c',ARGV[6],'cid','','cAt',ARGV[7])
    elseif ARGV[5] ~= 'abandon-run' then return 'pending' end
  end
  if ARGV[5] == 'datetime' or ARGV[5] == 'completed-datetime' then redis.call('HDEL',record,'ka') end
  local keyUntil = tonumber(redis.call('HGET', record, 'ku') or '0')
  -- The same keyed retention rule as ordinary completion; existing TTLs never extend.
  if keyUntil ~= -1 and redis.call('HEXISTS', record, 'ka') == 0
    and redis.call('PTTL', record) == -1 then
    local time = redis.call('TIME')
    local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
    redis.call('PEXPIREAT', record, math.max(nowMs + tonumber(ARGV[4]), keyUntil))
  end
  local remaining = redis.call('PTTL',record)
  if remaining >= 0 then redis.call('PEXPIRE', KEYS[6], remaining)
  else redis.call('PERSIST', KEYS[6]) end
  redis.call('UNLINK', watchers, queue, fanout)
  return 'retained'
`;

/** Only explicit invocations construct this service; no production lifecycle caller imports it. */
export class ManualWaitpointRollbackRecovery {
  constructor(
    private readonly deps: {
      target: string;
      controlPlane: Pick<PrismaClient, "organization" | "featureFlag" | "runtimeEnvironment">;
      runStore: Pick<RunStore, "findRunOnPrimary" | "findBatchTaskRunById">;
      assertRunId?: (runId: string) => void;
      redis: RedisClient;
      store: WaitpointStoreCoordinator;
      catalogMaintenance?: {
        schedule: (
          payload: { waitpointId: string; organizationId: string },
          availableAt: Date
        ) => Promise<void>;
        scheduledAt: (payload: {
          waitpointId: string;
          organizationId: string;
        }) => Promise<Date | undefined>;
      };
    }
  ) {}

  /** One explicit maintenance read, at most 100 index members and 100 ownership lookups. */
  async discover(input: {
    organizationId: string;
    kind: "runs" | "pending-sources" | "due" | "quarantine";
    partition: number;
    after?: { score: string; member: string };
  }) {
    identity.parse(input.organizationId);
    if (
      !Number.isInteger(input.partition) ||
      input.partition < 0 ||
      input.partition >= FANOUT_PARTITION_COUNT
    )
      throw new Error("Invalid discovery partition");
    await this.assertDisabled(input.organizationId);
    const key =
      input.kind === "runs"
        ? organizationRunIndexKey(input.organizationId, input.partition)
        : input.kind === "pending-sources"
          ? organizationPendingSourceIndexKey(input.organizationId, input.partition)
          : fanoutIndexKeys(input.partition)[input.kind];
    const page = (await this.deps.redis.eval(
      READ_INDEX_PAGE,
      1,
      key,
      input.after?.score ?? "",
      input.after?.member ?? ""
    )) as string[];
    const runs: Scope["runs"] = [];
    const sources: z.infer<typeof sourceSchema>[] = [];
    const unknown: string[] = [];
    for (let i = 0; i < page.length; i += 2) {
      const id = identity.parse(page[i]);
      if (input.kind === "runs") {
        runs.push({ runId: id, blockIds: [] });
        continue;
      }
      const receipt = await this.readSourceReceipt(input.organizationId, id);
      const [record, status, cid] = await this.deps.redis.hmget(
        waitpointKeys(id).record,
        "r",
        "status",
        "cid"
      );
      if (!record) {
        if (input.kind === "pending-sources") {
          sources.push({
            waitpointId: id,
            record: "",
            status: "PENDING",
            completionId: "",
            pendingRegistryOwned: true,
            ...receipt,
          });
          continue;
        }
        unknown.push(`Source ${id} has no immutable ownership record; hint retained`);
        continue;
      }
      const sourceRecord = JSON.parse(record);
      const environmentId = identity.parse(sourceRecord.environmentId);
      const environment = await this.deps.controlPlane.runtimeEnvironment.findUnique({
        where: { id: environmentId },
        select: { organizationId: true },
      });
      if (sourceRecord.organizationId && sourceRecord.organizationId !== input.organizationId)
        continue;
      if (
        !environment &&
        !(input.kind === "pending-sources" && sourceRecord.organizationId === input.organizationId)
      ) {
        unknown.push(`Source ${id} has unknown environment ownership; hint retained`);
        continue;
      }
      if (environment && environment.organizationId !== input.organizationId) continue;
      if (status !== "COMPLETED" && !(input.kind === "pending-sources" && status === "PENDING"))
        continue;
      sources.push(
        sourceSchema.parse({
          waitpointId: id,
          record,
          status,
          completionId: cid ?? "",
          pendingRegistryOwned: input.kind === "pending-sources",
          ...receipt,
        })
      );
    }
    const plan = runs.length
      ? await this.inspect({ organizationId: input.organizationId, runs }, "rollback", true)
      : {
          version: 1 as const,
          operation: "rollback" as const,
          target: this.deps.target,
          organizationId: input.organizationId,
          inspectedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          entries: [],
          sources: [],
          discovery: true,
          coverage: "bounded organization registry and completed-source discovery page" as const,
          unhandled: [],
        };
    plan.discovery = true;
    plan.sources = sources;
    plan.coverage = "bounded organization registry and completed-source discovery page";
    plan.unhandled = [
      "Only this discovery page is covered; continue all sixteen run, pending-sources and due/quarantine partitions to exhaustion. Future pending sources and live watchers are retained; permanent keyed record retention is preserved.",
      ...unknown,
    ];
    return {
      plan: rollbackPlanSchema.parse(plan),
      next:
        page.length === 200
          ? {
              ...input,
              after: { score: page[page.length - 1]!, member: page[page.length - 2]! },
            }
          : null,
    };
  }

  async assertDisabled(organizationId: string) {
    const org = await this.deps.controlPlane.organization.findUnique({
      where: { id: organizationId },
      select: { featureFlags: true },
    });
    if (!org) throw new Error("Organization not found");
    const flags = org.featureFlags;
    const override =
      flags && typeof flags === "object" && !Array.isArray(flags)
        ? flags.waitpointStoreEnabled
        : undefined;
    const global =
      typeof override === "boolean"
        ? undefined
        : await this.deps.controlPlane.featureFlag.findUnique({
            where: { key: "waitpointStoreEnabled" },
            select: { value: true },
          });
    if (typeof override === "boolean" ? override : global?.value === true) {
      throw new Error("Organization waitpoint store is enabled; refuse rollback cleanup");
    }
  }

  private async readRun(runId: string) {
    this.deps.assertRunId?.(runId);
    const run = await this.deps.runStore.findRunOnPrimary(
      { id: runId },
      {
        select: {
          id: true,
          organizationId: true,
          runtimeEnvironmentId: true,
          status: true,
          updatedAt: true,
          annotations: true,
        },
      }
    );
    if (!run) return null;
    const { annotations, ...identity } = run;
    return {
      ...identity,
      updatedAt: run.updatedAt.toISOString(),
      waitpointsOnStore: hasStoreWaitpoints(annotations),
    };
  }

  private async readNative(runId: string, blockIds: string[]): Promise<NativeState> {
    const k = runBlockKeys(runId);
    const keys = [
      k.state,
      k.pend,
      k.done,
      k.edge,
      k.refs,
      k.edgeIndex,
      k.doneOrder,
      k.early,
      k.earlyOrder,
      runResultKey(runId),
      runContributionIndexKey(runId),
      ...blockIds.flatMap((blockId) => [
        runWithdrawalKey(runId, blockId),
        runWithdrawalTargetsKey(runId, blockId),
      ]),
    ];
    const raw = JSON.parse(
      (await this.deps.redis.eval(READ_NATIVE, keys.length, ...keys, ...blockIds)) as string
    );
    if (!Array.isArray(raw.withdrawals)) raw.withdrawals = [];
    const state = nativeSchema.parse(raw);
    if (!["", "1"].includes(state.identity[4])) throw new Error("Invalid terminal state");
    if (state.identity[4] === "1" && state.identity[2])
      throw new Error("Terminal state has active block; inspect manually");
    if (
      !state.identity[2] &&
      state.identity[4] !== "1" &&
      state.keys.find((key) => key.name === "edges")!.count > 0
    ) {
      throw new Error("Edges without a block; inspect manually");
    }
    return state;
  }

  private async readSourceReceipt(organizationId: string, waitpointId: string) {
    const receiptMetadata = await this.deps.redis.hget(
      organizationSourceReceiptKey(organizationId, fanoutPartition(waitpointId)),
      waitpointId
    );
    const parsed = parseWaitpointId(waitpointId);
    const catalogMetadata =
      parsed.format === "b32hexW" && parsed.type === "MANUAL"
        ? await this.deps.redis.hget(
            manualWaitpointCatalogManifestKey(organizationId, waitpointId),
            waitpointId
          )
        : null;
    return {
      ...(catalogMetadata ? { catalogMetadata } : {}),
      ...(receiptMetadata
        ? {
            receiptMetadata,
            receiptValue: await this.deps.redis.get(
              receiptMetadataSchema.parse(JSON.parse(receiptMetadata)).key
            ),
          }
        : {}),
    };
  }

  private async inspectSources(
    runId: string,
    environmentId: string,
    supplied: string[],
    organizationId: string,
    blockIds: string[]
  ) {
    const ids = new Set(supplied);
    let remaining = RUN_CLEANUP_PAGE_SIZE;
    for (const blockId of blockIds) {
      if (!remaining) break;
      const page = await this.deps.store.readWithdrawalPage({ runId, blockId });
      for (const field of (page?.fields ?? []).slice(0, remaining)) {
        const edge = parseEdgeField(field);
        if (!edge) throw new Error("Invalid withdrawal source edge");
        ids.add(edge.waitpointId);
        remaining--;
      }
    }
    for (let offset = 0; ; offset += RUN_CLEANUP_PAGE_SIZE) {
      const page = await this.deps.redis.zrange(
        runBlockKeys(runId).edgeIndex,
        offset,
        offset + RUN_CLEANUP_PAGE_SIZE - 1
      );
      for (const field of page) {
        const edge = parseEdgeField(field);
        if (!edge) throw new Error("Invalid source edge");
        ids.add(edge.waitpointId);
      }
      if (page.length < RUN_CLEANUP_PAGE_SIZE) break;
    }
    const sources: z.infer<typeof sourceSchema>[] = [];
    for (const waitpointId of ids) {
      const receipt = await this.readSourceReceipt(organizationId, waitpointId);
      const pendingRegistryOwned =
        (await this.deps.redis.zscore(
          organizationPendingSourceIndexKey(organizationId, fanoutPartition(waitpointId)),
          waitpointId
        )) !== null;
      const [record, status, completionId] = await this.deps.redis.hmget(
        waitpointKeys(waitpointId).record,
        "r",
        "status",
        "cid"
      );
      if (!record) {
        if (
          (await this.deps.redis.exists(
            ...Object.values(waitpointKeys(waitpointId)),
            waitpointRelatedRunsKey(waitpointId)
          )) !== 0
        )
          throw new Error(`Source ${waitpointId} has leftovers without ownership metadata`);
        sources.push({
          waitpointId,
          record: "",
          status: "COMPLETED",
          completionId: "",
          pendingRegistryOwned,
          ...receipt,
        });
        continue;
      }
      if (JSON.parse(record).environmentId !== environmentId)
        throw new Error(`Source ${waitpointId} environment ownership mismatch`);
      sources.push(
        sourceSchema.parse({
          waitpointId,
          record,
          status,
          completionId: completionId ?? "",
          pendingRegistryOwned,
          ...receipt,
        })
      );
    }
    return sources;
  }

  async inspect(
    input: Scope,
    operation: RecoveryOperation = "rollback",
    discovery = false
  ): Promise<RollbackPlan> {
    const scope = rollbackScopeSchema.parse(input);
    if (new Set(scope.runs.map((run) => run.runId)).size !== scope.runs.length)
      throw new Error("Duplicate run IDs");
    recoveryOperationSchema.parse(operation);
    if (operation === "rollback") await this.assertDisabled(scope.organizationId);
    const entries: RollbackPlan["entries"] = [];
    for (const request of scope.runs) {
      const run = await this.readRun(request.runId);
      const registryOwned =
        operation === "rollback" &&
        !run &&
        (await this.deps.redis.zscore(
          organizationRunIndexKey(scope.organizationId, fanoutPartition(request.runId)),
          request.runId
        )) !== null;
      let native: NativeState | null = null;
      let sources: z.infer<typeof sourceSchema>[] = [];
      let blockIds = [...new Set(request.blockIds)];
      let classification: RollbackPlan["entries"][number]["classification"] = "unknown";
      let reason = "Missing run or organization ownership mismatch; no native access";
      if (run?.organizationId === scope.organizationId || (!run && registryOwned)) {
        if (run && !run.waitpointsOnStore) {
          classification = "legacy";
          reason = "Run has no native enrollment marker; untouched";
        } else {
          try {
            const historical = await this.deps.redis.zrange(
              runWithdrawalIndexKey(request.runId),
              0,
              97
            );
            blockIds = [...new Set([...blockIds, ...historical])];
            native = await this.readNative(request.runId, blockIds);
            blockIds = [...new Set([...blockIds, ...native.identity.slice(2, 4).filter(Boolean)])];
            native = await this.readNative(request.runId, blockIds);
            if (operation === "rollback" && run && !discovery)
              sources = await this.inspectSources(
                request.runId,
                run.runtimeEnvironmentId,
                request.sourceIds ?? [],
                scope.organizationId,
                blockIds
              );
            if (!run) {
              classification = "abandoned-registry-owned";
              reason =
                "Disabled organization; trusted native registry owns run whose SQL metadata is absent; explicit maintenance abandonment accepts enabled-era run loss";
            } else if (isFinalRunStatus(run.status)) {
              classification = "terminal";
              reason = "Terminal authoritative run; scoped native cleanup may be reviewed";
            } else {
              classification =
                native.keys.find((key) => key.name === "pending")!.count > 0
                  ? "pending"
                  : "active-requires-cancellation";
              reason =
                "Cancel through normal run lifecycle and wait for terminal status, then inspect again; age is not abandonment";
            }
          } catch (error) {
            reason = `Unknown native state; no cleanup: ${error instanceof Error ? error.message : String(error)}`;
            native = null;
          }
        }
      }
      entries.push({
        runId: request.runId,
        blockIds,
        sources,
        run,
        native,
        classification,
        registryOwned,
        eligible: classification === "terminal" || classification === "abandoned-registry-owned",
        reason,
      });
    }
    const now = Date.now();
    return {
      version: 1,
      operation,
      target: this.deps.target,
      organizationId: scope.organizationId,
      inspectedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
      entries,
      sources: [],
      discovery,
      coverage:
        operation === "contributions-only"
          ? "indexed contributions of supplied terminal runs only"
          : "supplied run partitions, indexed contributions and named withdrawal blocks only",
      unhandled:
        operation === "contributions-only"
          ? [
              ...UNHANDLED,
              "All other native run keys, watchers, withdrawals and retention are untouched; verification only certifies indexed contributions.",
            ]
          : UNHANDLED,
    };
  }

  private async checkTarget(
    plan: RollbackPlan,
    entry: RollbackPlan["entries"][number],
    mutation = true
  ) {
    if (plan.operation === "rollback") await this.assertDisabled(plan.organizationId);
    const current = await this.readRun(entry.runId);
    if (
      !entry.eligible ||
      !entry.native ||
      (entry.classification === "abandoned-registry-owned"
        ? plan.operation !== "rollback" ||
          !entry.registryOwned ||
          !!current ||
          (mutation &&
            (await this.deps.redis.zscore(
              organizationRunIndexKey(plan.organizationId, fanoutPartition(entry.runId)),
              entry.runId
            )) === null)
        : entry.classification !== "terminal" ||
          !entry.run ||
          !current ||
          current.organizationId !== plan.organizationId ||
          !current.waitpointsOnStore ||
          !isFinalRunStatus(current.status) ||
          !isDeepStrictEqual(current, entry.run))
    ) {
      throw new Error(
        `Run ${entry.runId} changed, is not owned, or needs cancellation; inspect again`
      );
    }
    const native = await this.readNative(entry.runId, entry.blockIds);
    const same = isDeepStrictEqual(native.identity, entry.native.identity);
    // An interrupted apply may have installed the durable terminal fence before withdrawals failed.
    // It cannot admit a new generation. Unchanged run metadata still gates this retry.
    const converging =
      native.identity[4] === "1" &&
      native.identity[2] === "" &&
      (native.identity[3] === "" || entry.blockIds.includes(native.identity[3]));
    if (!same && (plan.operation !== "rollback" || !converging))
      throw new Error(`Native cycle for ${entry.runId} changed; inspect again`);
    return native;
  }

  private async retireContributions(plan: RollbackPlan, entry: RollbackPlan["entries"][number]) {
    for (;;) {
      const native = await this.checkTarget(plan, entry);
      const members = await this.deps.redis.zrange(
        runContributionIndexKey(entry.runId),
        0,
        RUN_CLEANUP_PAGE_SIZE - 1
      );
      if (!members.length) return;
      const identities = members.map((member) =>
        z.tuple([identity, identity]).parse(JSON.parse(member))
      );
      for (const [blockId, absorptionId] of identities) {
        await this.checkTarget(plan, entry);
        await this.deps.store.releaseRegistrationSources({
          runId: entry.runId,
          blockId,
          absorptionId,
        });
      }
      const keys = [
        runBlockKeys(entry.runId).state,
        runContributionIndexKey(entry.runId),
        ...identities.map(([blockId, absorptionId]) =>
          runContributionKey(entry.runId, blockId, absorptionId)
        ),
      ];
      assertSingleSlot("rollback contributions", keys);
      await this.deps.redis.eval(
        RETIRE_CONTRIBUTIONS,
        keys.length,
        ...keys,
        ...native.identity,
        plan.operation,
        ...members
      );
    }
  }

  private async withdraw(
    plan: RollbackPlan,
    entry: RollbackPlan["entries"][number],
    blockId: string
  ) {
    const native = await this.checkTarget(plan, entry);
    await this.assertDisabled(plan.organizationId);
    const retained = await this.deps.store.terminalRetainAndClear({
      runId: entry.runId,
      blockId,
      expectedRollbackState: native.identity,
    });
    if (retained.outcome === "stale") throw new Error("Rollback block changed; inspect again");
    for (;;) {
      await this.checkTarget(plan, entry);
      const page = await this.deps.store.readWithdrawalPage({ runId: entry.runId, blockId });
      if (!page?.fields.length) break;
      const edges = page.fields.map((field) => {
        const edge = parseEdgeField(field);
        if (
          !edge ||
          (!plan.discovery &&
            entry.classification !== "abandoned-registry-owned" &&
            !entry.sources.some((source) => source.waitpointId === edge.waitpointId))
        )
          throw new Error(
            `Unreviewed withdrawal source ${field}; inspect again with explicit source IDs and preserve the previous plan source list`
          );
        return edge;
      });
      for (const edge of edges) {
        await this.assertDisabled(plan.organizationId);
        await this.deps.store.unregisterWatcher({ ...edge, runId: entry.runId, blockId });
      }
      await this.deps.store.acknowledgeWithdrawalPage({
        runId: entry.runId,
        blockId,
        fields: page.fields,
      });
    }
    await this.deps.store.finalizeRetainedWithdrawal({ runId: entry.runId, blockId });
  }

  private async cleanSources(plan: RollbackPlan, entry?: RollbackPlan["entries"][number]) {
    for (const source of entry?.sources ?? plan.sources) {
      if (entry) await this.checkTarget(plan, entry);
      if (!entry || source.receiptMetadata || source.catalogMetadata)
        await this.checkSourceOwner(plan, source);
      await this.assertDisabled(plan.organizationId);
      const receipt = source.receiptMetadata
        ? receiptMetadataSchema.parse(JSON.parse(source.receiptMetadata))
        : undefined;
      const receiptValue = receipt
        ? ((await this.deps.redis.eval(
            FENCE_SOURCE_RECEIPT,
            1,
            receipt.key,
            String(receipt.acceptUntil)
          )) as string)
        : undefined;
      // Missing acknowledged evidence never authorizes deleting an existing source. After
      // the Redis deadline, a reviewed absent source may retire only stale bookkeeping;
      // RETIRE_SOURCE atomically refuses if a record, watcher or paging key has since appeared.
      const missingReceipt = receiptValue === "";
      if (receiptValue === "pending" || (missingReceipt && source.record)) continue;
      const receiptWinner = missingReceipt
        ? undefined
        : receiptValue?.startsWith("completed:")
          ? receiptValue.slice("completed:".length)
          : receiptValue;
      const discardCandidate = receiptWinner !== undefined && receiptWinner !== source.waitpointId;
      if (discardCandidate && receiptWinner !== "cancelled") identity.parse(receiptWinner);
      let action = "";
      if (source.record) {
        const record = JSON.parse(source.record);
        if (["DATETIME", "MANUAL", "BATCH"].includes(record.type) && source.status === "COMPLETED")
          action = "completed-datetime";
        if (source.status === "PENDING" && source.pendingRegistryOwned) {
          const key = waitpointKeys(source.waitpointId).record;
          const elapsedDeadline =
            ["DATETIME", "MANUAL"].includes(record.type) &&
            Date.parse(record.completedAfter) <= Date.parse(plan.inspectedAt);
          if (discardCandidate) action = "discard-candidate";
          else if (elapsedDeadline && (await this.deps.redis.hget(key, "status")) === "COMPLETED")
            action = "datetime";
          else if ((await this.deps.redis.pttl(key)) > 0) action = "finite";
          else if (elapsedDeadline) action = "datetime";
          else if (record.type === "MANUAL")
            action = source.catalogMetadata ? "pending-manual" : "datetime";
          else if (record.type === "BATCH" && record.completedByBatchId) {
            const batch = await this.deps.runStore.findBatchTaskRunById(record.completedByBatchId);
            if (!batch || batch.status === "COMPLETED" || batch.status === "ABORTED")
              action = "abandon-run";
          } else if (
            record.type === "RUN" &&
            !record.userProvidedIdempotencyKey &&
            record.completedByTaskRunId
          ) {
            const child = await this.readRun(identity.parse(record.completedByTaskRunId));
            if (
              child &&
              (child.organizationId !== plan.organizationId ||
                child.runtimeEnvironmentId !== record.environmentId)
            )
              throw new Error(`Source ${source.waitpointId} child ownership changed`);
            if (!child || isFinalRunStatus(child.status)) action = "abandon-run";
          }
        }
      }
      if (source.catalogMetadata && source.record && action !== "discard-candidate") {
        const keyUntil = await this.deps.redis.hget(waitpointKeys(source.waitpointId).record, "ku");
        const ttl = await this.deps.redis.pttl(waitpointKeys(source.waitpointId).record);
        const pendingPreserved =
          source.status === "PENDING" && action !== "datetime" && action !== "abandon-run";
        if (!pendingPreserved && keyUntil !== "-1" && ttl !== -2) {
          if (!this.deps.catalogMaintenance)
            throw new Error(
              "Finite MANUAL catalog retention requires workerQueue scheduler configuration before cleanup"
            );
          await this.deps.catalogMaintenance.schedule(
            { waitpointId: source.waitpointId, organizationId: plan.organizationId },
            new Date(
              ttl >= 0
                ? Date.now() + ttl
                : Math.max(Date.now() + DEFAULT_TERMINAL_RETENTION_MS, Number(keyUntil ?? 0))
            )
          );
        }
      }
      const completion = this.naturalCompletion(plan, source);
      if (source.catalogMetadata && action === "datetime")
        await this.deps.store.manualCatalog.publishCompletedCandidate(
          JSON.parse(source.record),
          JSON.parse(completion).outputIsError
        );
      const keys = [
        ...Object.values(waitpointKeys(source.waitpointId)),
        candidateMintFenceKey(source.waitpointId),
        waitpointRelatedRunsKey(source.waitpointId),
      ];
      assertSingleSlot("rollback source", keys);
      const outcome = await this.deps.redis.eval(
        RETIRE_SOURCE,
        keys.length,
        ...keys,
        source.record,
        source.completionId,
        source.status,
        String(DEFAULT_TERMINAL_RETENTION_MS),
        action,
        completion,
        String(Date.parse(plan.inspectedAt)),
        receipt ? String(receipt.acceptUntil) : ""
      );
      if (outcome === "pending" || outcome === "live-watchers" || outcome === "held") continue;
      if (outcome !== "retained" && outcome !== "absent")
        throw new Error(`Source ${source.waitpointId} cleanup refused: ${outcome}`);
      if (receipt) {
        await this.assertDisabled(plan.organizationId);
        // Preserve the exact published outcome and permanent reservation. Only this attempt's
        // receipt receives retention, after the reviewed source/fence has converged.
        await this.deps.redis.eval(
          `local value = redis.call('GET',KEYS[1])
           if not value then return 0 end
           local time = redis.call('TIME')
           local nowMs = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
           if value ~= ARGV[1] then return redis.error_reply('Source receipt changed; inspect again') end
           if value == 'pending' then return redis.error_reply('Source publication is not yet fenced') end
           if redis.call('PTTL',KEYS[1]) == -1 then
             redis.call('PEXPIREAT',KEYS[1],math.max(nowMs,tonumber(ARGV[2]))+tonumber(ARGV[3]))
           end
           return 1`,
          1,
          receipt.key,
          receiptValue ?? "",
          String(receipt.acceptUntil),
          String(DEFAULT_TERMINAL_RETENTION_MS)
        );
      }
      if (source.catalogMetadata && source.record)
        await this.deps.store.manualCatalog.reconcileStatus(JSON.parse(source.record));
      if (source.catalogMetadata && this.deps.catalogMaintenance) {
        const ttl = await this.deps.redis.pttl(waitpointKeys(source.waitpointId).record);
        if (ttl >= 0)
          await this.deps.catalogMaintenance.schedule(
            { waitpointId: source.waitpointId, organizationId: plan.organizationId },
            new Date(Date.now() + ttl + 1)
          );
      }
      // Cross-slot second effect. The saved plan retains this ID/cid even if the source
      // expires before replay. A missing source is accepted only with all source keys absent.
      await this.assertDisabled(plan.organizationId);
      const index = fanoutIndexKeys(fanoutPartition(source.waitpointId));
      const ownership = organizationPendingSourceIndexKey(
        plan.organizationId,
        fanoutPartition(source.waitpointId)
      );
      const metadata = organizationSourceReceiptKey(
        plan.organizationId,
        fanoutPartition(source.waitpointId)
      );
      if (source.catalogMetadata) {
        const remaining = await this.deps.redis.pttl(waitpointKeys(source.waitpointId).record);
        if (
          remaining === -2 &&
          !(await this.deps.store.manualCatalog.retire(
            parseManualWaitpointCatalogManifest(source.catalogMetadata)
          ))
        )
          throw new Error("MANUAL catalog publication fence is still open");
      }
      const catalog = manualWaitpointCatalogManifestKey(plan.organizationId, source.waitpointId);
      assertSingleSlot("rollback source index", [
        ...Object.values(index),
        ownership,
        metadata,
        catalog,
      ]);
      await this.deps.redis.eval(
        `local current = redis.call('HGET',KEYS[4],ARGV[1])
         if current and current ~= ARGV[2] then return redis.error_reply('Source receipt identity changed') end
         redis.call('HDEL',KEYS[4],ARGV[1])
         for i=1,2 do redis.call('ZREM',KEYS[i],ARGV[1]) end
         if redis.call('HEXISTS',KEYS[5],ARGV[1]) == 0 then redis.call('ZREM',KEYS[3],ARGV[1]) end; return 1`,
        5,
        index.due,
        index.quarantine,
        ownership,
        metadata,
        catalog,
        source.waitpointId,
        source.receiptMetadata ?? ""
      );
    }
  }

  private naturalCompletion(plan: RollbackPlan, source: z.infer<typeof sourceSchema>) {
    // An elapsed MANUAL deadline completes with the same timeout error as ordinary expiry.
    const record = source.record ? JSON.parse(source.record) : {};
    const timedOut =
      record.type === "MANUAL" && Date.parse(record.completedAfter) <= Date.parse(plan.inspectedAt);
    return JSON.stringify({
      completedAt: plan.inspectedAt,
      outputType: "application/json",
      outputIsError: Boolean(timedOut),
      output: timedOut
        ? { inline: JSON.stringify(timeoutError(new Date(record.completedAfter))) }
        : null,
    });
  }

  private async checkSourceOwner(plan: RollbackPlan, source: z.infer<typeof sourceSchema>) {
    if (source.catalogMetadata) {
      const manifest = parseManualWaitpointCatalogManifest(source.catalogMetadata);
      if (
        manifest.organizationId !== plan.organizationId ||
        manifest.waitpointId !== source.waitpointId
      )
        throw new Error("Catalog source ownership mismatch");
      const current = await this.deps.store.manualCatalog.getManifest(
        plan.organizationId,
        source.waitpointId
      );
      if (current && !isDeepStrictEqual(current, manifest))
        throw new Error("Catalog source manifest changed; inspect again");
    }
    if (source.receiptMetadata) {
      const receipt = receiptMetadataSchema.parse(JSON.parse(source.receiptMetadata));
      const metadata = await this.deps.redis.hget(
        organizationSourceReceiptKey(plan.organizationId, fanoutPartition(source.waitpointId)),
        source.waitpointId
      );
      if (
        metadata !== source.receiptMetadata &&
        (metadata !== null || (await this.deps.redis.pttl(receipt.key)) === -1)
      )
        throw new Error(`Source ${source.waitpointId} receipt ownership changed`);
    }
    if (source.pendingRegistryOwned) {
      const member = await this.deps.redis.zscore(
        organizationPendingSourceIndexKey(plan.organizationId, fanoutPartition(source.waitpointId)),
        source.waitpointId
      );
      // A replay may already have removed the index after making the source finite/absent.
      if (!source.record) {
        if (
          member === null &&
          (await this.deps.redis.exists(
            ...Object.values(waitpointKeys(source.waitpointId)),
            waitpointRelatedRunsKey(source.waitpointId)
          )) !== 0
        )
          throw new Error(`Source ${source.waitpointId} missing publication ownership changed`);
        return;
      }
    }
    const environmentId = identity.parse(JSON.parse(source.record).environmentId);
    const environment = await this.deps.controlPlane.runtimeEnvironment.findUnique({
      where: { id: environmentId },
      select: { organizationId: true },
    });
    const recordOrganizationId = JSON.parse(source.record).organizationId;
    if (
      (recordOrganizationId && recordOrganizationId !== plan.organizationId) ||
      (environment
        ? environment.organizationId !== plan.organizationId
        : !(source.pendingRegistryOwned && recordOrganizationId === plan.organizationId))
    )
      throw new Error(`Source ${source.waitpointId} ownership changed or is unknown`);
  }

  async apply(
    input: RollbackPlan,
    runIds: string[],
    maintenanceWindowConfirmed: boolean,
    sourceIds: string[] = []
  ) {
    const plan = rollbackPlanSchema.parse(input);
    const results: Array<
      | ({ runId: string } & Awaited<ReturnType<typeof this.verifyEntry>>)
      | { runId: string; verified: false; error: string }
    > = [];
    const errors: Array<{
      stage: "preflight" | "run" | "verification" | "source-cleanup" | "source-verification";
      error: string;
      runId?: string;
      waitpointId?: string;
    }> = [];
    const sources: Awaited<ReturnType<typeof this.verifySources>> = [];
    const report = () => ({
      operation: plan.operation,
      coverage: plan.coverage,
      unhandled: plan.unhandled,
      results,
      sources,
      errors,
    });
    let selected: RollbackPlan["entries"] = [];
    let selectedSources: RollbackPlan["sources"] = [];
    try {
      if (!maintenanceWindowConfirmed)
        throw new Error("Confirm the documented maintenance window before applying");
      if (
        plan.target !== this.deps.target ||
        !Number.isFinite(Date.parse(plan.expiresAt)) ||
        Date.now() > Date.parse(plan.expiresAt)
      ) {
        throw new Error("Plan expired or belongs to another deployment; inspect again");
      }
      if (
        (!runIds.length && !sourceIds.length) ||
        runIds.length + sourceIds.length > 100 ||
        new Set(runIds).size !== runIds.length ||
        new Set(sourceIds).size !== sourceIds.length
      )
        throw new Error("Explicit unique reviewed run selection is required");
      selected = runIds.map((id) => {
        const entry = plan.entries.find((entry) => entry.runId === id);
        if (!entry) throw new Error(`Run ${id} was not inspected`);
        return entry;
      });
      selectedSources = sourceIds.map((id) => {
        const source = plan.sources.find((source) => source.waitpointId === id);
        if (!source) throw new Error(`Source ${id} was not inspected`);
        return source;
      });
      for (const source of selectedSources) await this.checkSourceOwner(plan, source);
      if (!this.deps.catalogMaintenance)
        for (const source of [...selectedSources, ...selected.flatMap((entry) => entry.sources)]) {
          if (
            !source.catalogMetadata ||
            !source.record ||
            (await this.deps.redis.pttl(waitpointKeys(source.waitpointId).record)) === -2
          )
            continue;
          const record = JSON.parse(source.record);
          const keyUntil = await this.deps.redis.hget(
            waitpointKeys(source.waitpointId).record,
            "ku"
          );
          if (
            keyUntil !== "-1" &&
            (source.status === "COMPLETED" ||
              (record.completedAfter &&
                Date.parse(record.completedAfter) <= Date.parse(plan.inspectedAt)))
          )
            throw new Error(
              "Finite MANUAL catalog retention requires workerQueue scheduler configuration before cleanup"
            );
        }
      // Preflight all selected targets before the first mutation; revalidate again at each target.
      for (const entry of selected) await this.checkTarget(plan, entry);
    } catch (error) {
      errors.push({
        stage: "preflight",
        error: error instanceof Error ? error.message : String(error),
      });
      return report();
    }
    for (const entry of selected) {
      try {
        const native = await this.checkTarget(plan, entry);
        if (plan.operation === "contributions-only") {
          await this.retireContributions(plan, entry);
          results.push({ runId: entry.runId, ...(await this.verifyEntry(plan, entry)) });
          continue;
        }
        if (
          native.identity[4] === "1" &&
          !native.identity[3] &&
          native.keys.every((key) => key.ttlMs !== -1) &&
          native.withdrawals.every((block) => !block.present && !block.targets)
        ) {
          await this.cleanSources(plan, entry);
          await this.deps.store.retireRunOwnership(entry.runId, plan.organizationId);
          results.push({ runId: entry.runId, ...(await this.verifyEntry(plan, entry)) });
          continue;
        }
        const targets = [
          ...new Set([native.identity[2], native.identity[3], ...entry.blockIds].filter(Boolean)),
        ];
        if (!targets.length) {
          await this.assertDisabled(plan.organizationId);
          await this.deps.store.releaseRunWatchers({
            runId: entry.runId,
            reason: "terminal",
            expectedRollbackState: native.identity,
          });
        } else {
          for (const blockId of targets) await this.withdraw(plan, entry, blockId);
          // A finalized historical block may have no withdrawal left to install the
          // terminal fence. Arm retention from a fresh, guarded native identity.
          const withdrawn = await this.checkTarget(plan, entry);
          if (withdrawn.identity[4] !== "1") {
            await this.assertDisabled(plan.organizationId);
            await this.deps.store.cleanupRunBlockState({
              runId: entry.runId,
              reason: "terminal",
              expectedRollbackState: withdrawn.identity,
            });
          }
        }
        await this.retireContributions(plan, entry);
        await this.cleanSources(plan, entry);
        await this.deps.store.retireRunOwnership(entry.runId, plan.organizationId);
        results.push({ runId: entry.runId, ...(await this.verifyEntry(plan, entry)) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ runId: entry.runId, verified: false, error: message });
        errors.push({ stage: "run", runId: entry.runId, error: message });
        break; // Preserve the manifest and rerun after investigating the first failure.
      }
    }
    // Earlier selected parents may share a source with later selected parents. Live watchers
    // retain that source without aborting later withdrawals; report the final converged state.
    for (let i = 0; i < results.length; i++) {
      const result: { runId: string; error?: string } = results[i]!;
      if ("error" in result) continue;
      const entry: RollbackPlan["entries"][number] = selected.find(
        (entry) => entry.runId === result.runId
      )!;
      try {
        results[i] = { runId: entry.runId, ...(await this.verifyEntry(plan, entry)) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[i] = { runId: entry.runId, verified: false, error: message };
        errors.push({ stage: "verification", runId: entry.runId, error: message });
      }
    }
    if (!errors.length) {
      for (const source of selectedSources) {
        try {
          await this.assertDisabled(plan.organizationId);
          await this.cleanSources({ ...plan, sources: [source] });
        } catch (error) {
          errors.push({
            stage: "source-cleanup",
            waitpointId: source.waitpointId,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
    }
    for (const source of selectedSources) {
      try {
        sources.push(...(await this.verifySources({ ...plan, sources: [source] })));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sources.push({ waitpointId: source.waitpointId, verified: false });
        errors.push({
          stage: "source-verification",
          waitpointId: source.waitpointId,
          error: message,
        });
      }
    }
    return report();
  }

  private async readSourceVerification(waitpointId: string) {
    const k = waitpointKeys(waitpointId);
    const keys = [k.record, k.watchers, k.queue, k.fanout, waitpointRelatedRunsKey(waitpointId)];
    assertSingleSlot("rollback source verification", keys);
    return (await this.deps.redis.eval(READ_SOURCE_VERIFICATION, keys.length, ...keys)) as [
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      number,
      number,
      number,
      number,
    ];
  }

  private async verifySources(plan: RollbackPlan) {
    const results = [];
    for (const source of plan.sources) {
      await this.assertDisabled(plan.organizationId);
      await this.checkSourceOwner(plan, source);
      const index = fanoutIndexKeys(fanoutPartition(source.waitpointId));
      const [
        record,
        status,
        cid,
        keyUntil,
        ,
        completion,
        absent,
        retentionValid,
        ttl,
        pendingRetentionValid,
      ] = await this.readSourceVerification(source.waitpointId);
      const catalog = source.catalogMetadata
        ? await this.deps.store.manualCatalog.getManifest(plan.organizationId, source.waitpointId)
        : undefined;
      const intentionalPending = Boolean(
        catalog && status === "PENDING" && record && JSON.parse(record).type === "MANUAL"
      );
      if (catalog && ttl >= 0 && !this.deps.catalogMaintenance)
        throw new Error(
          "Finite MANUAL catalog retention requires workerQueue scheduler configuration for verification"
        );
      const intentionalRetention = Boolean(catalog && (status === "PENDING" || keyUntil === "-1"));
      const maintenanceAvailableAt =
        catalog && ttl >= 0
          ? await this.deps.catalogMaintenance?.scheduledAt({
              waitpointId: source.waitpointId,
              organizationId: plan.organizationId,
            })
          : undefined;
      const catalogVerified =
        !catalog ||
        (record !== null &&
          (intentionalRetention ||
            Boolean(maintenanceAvailableAt && maintenanceAvailableAt.getTime() > Date.now())));

      const retained =
        record === source.record &&
        (status === source.status ||
          (source.pendingRegistryOwned &&
            status === "COMPLETED" &&
            completion === this.naturalCompletion(plan, source))) &&
        (cid ?? "") === source.completionId &&
        (retentionValid === 1 || (intentionalPending && pendingRetentionValid === 1));
      results.push({
        waitpointId: source.waitpointId,
        ...(catalog
          ? {
              catalogRetention: intentionalRetention ? "intentional" : "finite",
              maintenanceAvailableAt: maintenanceAvailableAt?.toISOString(),
            }
          : {}),
        verified:
          (absent === 1 || retained) &&
          catalogVerified &&
          (await this.deps.redis.zscore(index.due, source.waitpointId)) === null &&
          (await this.deps.redis.zscore(index.quarantine, source.waitpointId)) === null &&
          (await this.deps.redis.zscore(
            organizationPendingSourceIndexKey(
              plan.organizationId,
              fanoutPartition(source.waitpointId)
            ),
            source.waitpointId
          )) === (catalog ? "0" : null) &&
          (await this.deps.redis.hexists(
            organizationSourceReceiptKey(plan.organizationId, fanoutPartition(source.waitpointId)),
            source.waitpointId
          )) === 0 &&
          (!source.receiptMetadata ||
            (await this.deps.redis.pttl(
              receiptMetadataSchema.parse(JSON.parse(source.receiptMetadata)).key
            )) !== -1),
        ...(await this.registrationHold(source.waitpointId, record, retained)),
      });
    }
    return results;
  }

  /** One extra read, only for an unretained or unverified source that still has its record. */
  private async registrationHold(
    waitpointId: string,
    record: string | null,
    settled: boolean | undefined
  ) {
    if (settled || record === null) return {};
    const holds = Number(await this.deps.redis.hget(waitpointKeys(waitpointId).record, "rh"));
    return holds > 0 ? { registrationHold: true as const, disposition: REGISTRATION_HOLD } : {};
  }

  private async verifyEntry(plan: RollbackPlan, entry: RollbackPlan["entries"][number]) {
    const state = await this.checkTarget(plan, entry, false);
    if (plan.operation === "contributions-only") {
      return {
        verified: state.keys.find((key) => key.name === "contributions")!.count === 0,
        native: state,
      };
    }
    const sources = [];
    for (const source of entry.sources) {
      const [record, status, cid, , , , absent, retentionValid] = await this.readSourceVerification(
        source.waitpointId
      );
      const index = fanoutIndexKeys(fanoutPartition(source.waitpointId));
      const unchanged =
        record === source.record && status === source.status && (cid ?? "") === source.completionId;
      const managed =
        source.catalogMetadata ||
        source.receiptMetadata ||
        (source.pendingRegistryOwned && !unchanged);
      const managedResult = managed
        ? (await this.verifySources({ ...plan, sources: [source] }))[0]
        : undefined;
      const verified = managed
        ? managedResult!.verified
        : source.status === "PENDING"
          ? unchanged
          : (absent === 1 || (unchanged && retentionValid === 1)) &&
            (await this.deps.redis.zscore(index.due, source.waitpointId)) === null &&
            (await this.deps.redis.zscore(index.quarantine, source.waitpointId)) === null;
      sources.push({
        ...managedResult,
        waitpointId: source.waitpointId,
        verified,
        status: source.status,
        disposition: source.receiptMetadata
          ? verified
            ? "tracked keyed source and receipt converged"
            : "tracked keyed source or receipt cleanup outstanding"
          : managed
            ? verified
              ? "registry-owned source converged"
              : "registry-owned source cleanup outstanding"
            : source.status === "PENDING"
              ? "pending source retained; cleanup excluded"
              : verified
                ? "completed source converged"
                : "completed source cleanup outstanding",
      });
    }
    const persistent = state.keys.filter((key) => key.ttlMs === -1);
    const obligations = state.withdrawals.filter((block) => block.present || block.targets > 0);
    return {
      verified:
        sources.every((source) => source.verified) &&
        persistent.length === 0 &&
        (await this.deps.redis.zscore(
          organizationRunIndexKey(plan.organizationId, fanoutPartition(entry.runId)),
          entry.runId
        )) === null &&
        obligations.length === 0 &&
        (await this.deps.redis.zcard(runWithdrawalIndexKey(entry.runId))) === 0 &&
        !state.identity[2] &&
        !state.identity[3],
      native: state,
      sources,
    };
  }

  async verify(input: RollbackPlan) {
    const plan = rollbackPlanSchema.parse(input);
    if (plan.target !== this.deps.target) throw new Error("Plan belongs to another deployment");
    const results = [];
    for (const entry of plan.entries.filter((entry) => entry.eligible)) {
      try {
        results.push({ runId: entry.runId, ...(await this.verifyEntry(plan, entry)) });
      } catch (error) {
        results.push({
          runId: entry.runId,
          verified: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const sources: Awaited<ReturnType<typeof this.verifySources>> = [];
    const errors: Array<{ stage: "source-verification"; waitpointId: string; error: string }> = [];
    for (const source of plan.sources) {
      try {
        sources.push(...(await this.verifySources({ ...plan, sources: [source] })));
      } catch (error) {
        sources.push({ waitpointId: source.waitpointId, verified: false });
        errors.push({
          stage: "source-verification",
          waitpointId: source.waitpointId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      operation: plan.operation,
      coverage: plan.coverage,
      unhandled: plan.unhandled,
      results,
      sources,
      errors,
    };
  }
}
