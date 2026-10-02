import type { RedisClient } from "@internal/redis";
import {
  ACK,
  CANCEL,
  CLAIM,
  ENV_CONFIRM,
  ENV_RESERVE,
  FRONT_GATE,
  REGISTER,
  RESERVE,
} from "./scripts.js";
import { URL_SHAPE } from "./match.js";

export type WaiterLimits = {
  perEnvironment: number;
  perEndpoint: number;
  shapes: number;
};

export type WaiterLimitReason = "environment_limit" | "endpoint_limit" | "shape_limit";

/** A delivery's claim: how many waiters it claimed, how many it gave up on, how many are still to resume. */
export type ClaimCounts = { claimed: number; failed: number; remaining: number; error?: string };

export type RegisterOutcome =
  | { outcome: "registered" }
  | { outcome: "cancelled" }
  | { outcome: "claimed"; deliveryId: string }
  | { outcome: "limit"; reason: WaiterLimitReason };

export type WaiterIndex = {
  environmentId: string;
  endpointId: string;
  shape: string;
  values: string;
  expiresAt: number;
  /** What the waiter was created with, kept for the dashboard; matching uses the hashes above. */
  match?: Record<string, string | number | boolean>;
  filter?: string;
};

export type WaiterCandidateGroup = { shape: string; values: string; ids: string[] };

type ScriptClient = RedisClient & {
  wwFrontGate(
    gate: string,
    ws: string,
    wwe: string,
    value: string,
    ttl: number
  ): Promise<unknown[]>;
  wwReserve(...args: Array<string | number>): Promise<unknown[]>;
  wwRegister(...args: Array<string | number>): Promise<unknown[]>;
  wwCancel(...args: Array<string | number>): Promise<unknown[]>;
  wwClaim(numKeys: number, ...args: Array<string | number>): Promise<unknown[]>;
  wwEnvReserve(wwenv: string, member: string, ttlMs: number, cap: number): Promise<unknown[]>;
  wwEnvConfirm(
    wwenv: string,
    reservation: string,
    waiterId: string,
    expiresAt: number
  ): Promise<number>;
  wwAck(
    wwc: string,
    wwcm: string,
    wwe: string,
    mode: string,
    error: string,
    ...ids: string[]
  ): Promise<unknown[]>;
};

/**
 * The webhook waiter store: live waiters per endpoint in sorted sets that die by score (expiry),
 * cancel or claim, with no sweep job. Every key carries the `{endpointId}` hash tag so each script
 * runs on one slot of a cluster. The client must not have a `keyPrefix`: the claim script's key list
 * is dynamic, which the client can't prefix, so keys are prefixed here instead.
 */
export class WebhookWaiterStore {
  private readonly client: ScriptClient;

  constructor(
    client: RedisClient,
    private readonly prefix: string,
    private readonly limits: WaiterLimits,
    private readonly reserveTtlMs = 60_000
  ) {
    client.defineCommand("wwFrontGate", { numberOfKeys: 3, lua: FRONT_GATE });
    client.defineCommand("wwReserve", { numberOfKeys: 5, lua: RESERVE });
    client.defineCommand("wwRegister", { numberOfKeys: 7, lua: REGISTER });
    client.defineCommand("wwCancel", { numberOfKeys: 5, lua: CANCEL });
    client.defineCommand("wwClaim", { lua: CLAIM });
    client.defineCommand("wwAck", { numberOfKeys: 3, lua: ACK });
    client.defineCommand("wwEnvReserve", { numberOfKeys: 1, lua: ENV_RESERVE });
    client.defineCommand("wwEnvConfirm", { numberOfKeys: 1, lua: ENV_CONFIRM });
    this.client = client as ScriptClient;
  }

  get redis(): RedisClient {
    return this.client;
  }

  #tag(endpointId: string) {
    return `{${endpointId}}`;
  }

  #endpointKeys(endpointId: string) {
    const t = this.#tag(endpointId);
    return {
      ws: `${this.prefix}ws:${t}`,
      wsp: `${this.prefix}wsp:${t}`,
      wwe: `${this.prefix}wwe:${t}`,
      wwst: `${this.prefix}wwst:${t}`,
      wwsx: `${this.prefix}wwsx:${t}`,
    };
  }

  #waiterKeys(endpointId: string, shape: string, values: string) {
    const t = this.#tag(endpointId);
    return {
      ww: `${this.prefix}ww:${t}:${shape}:${values}`,
      wwf: `${this.prefix}wwf:${t}:${shape}:${values}`,
    };
  }

  #claimKey(endpointId: string, deliveryId: string) {
    return `${this.prefix}wwc:${this.#tag(endpointId)}:${deliveryId}`;
  }

  #claimCountsKey(endpointId: string, deliveryId: string) {
    return `${this.prefix}wwcm:${this.#tag(endpointId)}:${deliveryId}`;
  }

  #environmentKey(environmentId: string) {
    return `${this.prefix}wwenv:${this.#tag(environmentId)}`;
  }

  #indexKey(waiterId: string) {
    return `${this.prefix}wwidx:${waiterId}`;
  }

  gateKey(endpointId: string, idempotencyKey: string) {
    return `${this.prefix}webhookdedupe:${this.#tag(endpointId)}:${idempotencyKey}`;
  }

  /**
   * Claim the ingest dedupe key. On a fresh claim, returns the shard's clock as the delivery's
   * arrival time and whether the endpoint has live waiters a delivery could match.
   */
  async claimFrontGate(
    endpointId: string,
    idempotencyKey: string,
    value: string,
    claimTtlSeconds: number
  ): Promise<
    | { claimed: true; arrivedAt: number; hasLiveWaiters: boolean }
    | { claimed: false; existing: string | undefined }
  > {
    const e = this.#endpointKeys(endpointId);
    const reply = await this.client.wwFrontGate(
      this.gateKey(endpointId, idempotencyKey),
      e.ws,
      e.wwe,
      value,
      claimTtlSeconds
    );
    if (Number(reply[0]) === 1) {
      return {
        claimed: true,
        arrivedAt: Number(reply[1]),
        hasLiveWaiters: Number(reply[2]) > 0 && Number(reply[3]) > 0,
      };
    }
    const existing = String(reply[1] ?? "");
    return { claimed: false, existing: existing || undefined };
  }

  async promoteFrontGate(
    endpointId: string,
    idempotencyKey: string,
    value: string,
    ttlSeconds: number
  ) {
    await this.client.set(this.gateKey(endpointId, idempotencyKey), value, "EX", ttlSeconds);
  }

  async releaseFrontGate(endpointId: string, idempotencyKey: string) {
    await this.client.del(this.gateKey(endpointId, idempotencyKey));
  }

  async reserve(
    endpointId: string,
    shape: string,
    values: string,
    token: string,
    limits: WaiterLimits = this.limits
  ): Promise<{ outcome: "ok" } | { outcome: "limit"; reason: WaiterLimitReason }> {
    const e = this.#endpointKeys(endpointId);
    const w = this.#waiterKeys(endpointId, shape, values);
    const reply = await this.client.wwReserve(
      w.ww,
      w.wwf,
      e.wwe,
      e.ws,
      e.wsp,
      token,
      this.reserveTtlMs,
      shape,
      limits.perEndpoint,
      limits.shapes,
      shape === URL_SHAPE ? "0" : "1"
    );
    const status = String(reply[0]);
    if (status === "ok") return { outcome: "ok" };
    return { outcome: "limit", reason: status as WaiterLimitReason };
  }

  /** Hold one of the environment's live waiter slots for a create in progress. */
  async reserveEnvironment(
    environmentId: string,
    token: string,
    cap: number = this.limits.perEnvironment
  ): Promise<boolean> {
    const reply = await this.client.wwEnvReserve(
      this.#environmentKey(environmentId),
      `r:${token}`,
      this.reserveTtlMs,
      cap
    );
    return String(reply[0]) === "ok";
  }

  /** Count a registered waiter against its environment until it expires. */
  async confirmEnvironment(
    environmentId: string,
    token: string | undefined,
    waiterId: string,
    expiresAt: number
  ) {
    await this.client.wwEnvConfirm(
      this.#environmentKey(environmentId),
      token ? `r:${token}` : "",
      waiterId,
      expiresAt
    );
  }

  /** Give back environment slots: a reservation (`r:<token>`) or waiters that resumed or were cancelled. */
  async releaseEnvironment(environmentId: string, members: string[]) {
    if (members.length === 0) return;
    await this.client.zrem(this.#environmentKey(environmentId), ...members);
  }

  /** Live waiters the environment holds, counting creates in progress. */
  async environmentCount(environmentId: string) {
    return this.client.zcount(this.#environmentKey(environmentId), Date.now(), "+inf");
  }

  async register(params: {
    endpointId: string;
    shape: string;
    values: string;
    paths: string[];
    token: string;
    waiterId: string;
    expiresAt: number;
    filter: string | undefined;
    limits?: WaiterLimits;
  }): Promise<RegisterOutcome> {
    const limits = params.limits ?? this.limits;
    const e = this.#endpointKeys(params.endpointId);
    const w = this.#waiterKeys(params.endpointId, params.shape, params.values);
    const reply = await this.client.wwRegister(
      w.ww,
      w.wwf,
      e.wwe,
      e.ws,
      e.wsp,
      e.wwst,
      e.wwsx,
      params.token,
      params.waiterId,
      params.expiresAt,
      params.filter ?? "",
      params.shape,
      JSON.stringify(params.paths),
      limits.perEndpoint,
      limits.shapes,
      params.shape === URL_SHAPE ? "0" : "1"
    );
    const status = String(reply[0]);
    switch (status) {
      case "registered":
        return { outcome: "registered" };
      case "cancelled":
        return { outcome: "cancelled" };
      case "claimed":
        return { outcome: "claimed", deliveryId: String(reply[2]) };
      default:
        return { outcome: "limit", reason: status as WaiterLimitReason };
    }
  }

  async cancel(
    endpointId: string,
    shape: string,
    values: string,
    waiterId: string
  ): Promise<
    | { outcome: "cancelled" }
    | { outcome: "too_late"; deliveryId: string }
    | { outcome: "not_found" }
  > {
    const e = this.#endpointKeys(endpointId);
    const w = this.#waiterKeys(endpointId, shape, values);
    const reply = await this.client.wwCancel(w.ww, w.wwf, e.wwe, e.wwst, e.wwsx, waiterId);
    const status = String(reply[0]);
    if (status === "cancelled") return { outcome: "cancelled" };
    if (status === "too_late") return { outcome: "too_late", deliveryId: String(reply[1]) };
    return { outcome: "not_found" };
  }

  async writeIndex(waiterId: string, index: WaiterIndex) {
    const ttl = Math.max(index.expiresAt - Date.now(), 0) + 3_600_000;
    await this.client.set(this.#indexKey(waiterId), JSON.stringify(index), "PX", ttl);
  }

  async readIndex(waiterId: string): Promise<WaiterIndex | undefined> {
    const raw = await this.client.get(this.#indexKey(waiterId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as WaiterIndex;
    } catch {
      return undefined;
    }
  }

  /** Live match shapes on the endpoint at `now`, with their paths. */
  async liveShapes(
    endpointId: string,
    now: number
  ): Promise<Array<{ shape: string; paths: string[] }>> {
    const e = this.#endpointKeys(endpointId);
    const shapes = await this.client.zrangebyscore(e.ws, now, "+inf");
    if (shapes.length === 0) return [];
    const pathsList = await this.client.hmget(e.wsp, ...shapes);
    const result: Array<{ shape: string; paths: string[] }> = [];
    shapes.forEach((shape, i) => {
      const raw = pathsList[i];
      if (!raw) return;
      try {
        result.push({ shape, paths: JSON.parse(raw) as string[] });
      } catch {}
    });
    return result;
  }

  /** Live waiters on one match key at `now`, with their registration time and filter. */
  async liveWaiters(
    endpointId: string,
    shape: string,
    values: string,
    now: number
  ): Promise<Array<{ id: string; registeredAt: number; filter: string | undefined }>> {
    const w = this.#waiterKeys(endpointId, shape, values);
    const members = (await this.client.zrangebyscore(w.ww, now, "+inf")).filter(
      (member) => !member.startsWith("r:")
    );
    if (members.length === 0) return [];
    const infos = await this.client.hmget(w.wwf, ...members);
    const result: Array<{ id: string; registeredAt: number; filter: string | undefined }> = [];
    members.forEach((id, i) => {
      const info = infos[i];
      if (!info) return;
      const bar = info.indexOf("|");
      const filter = info.slice(bar + 1);
      result.push({ id, registeredAt: Number(info.slice(0, bar)), filter: filter || undefined });
    });
    return result;
  }

  /** Claim the delivery's waiters, or return the ones it already claimed and hasn't acked. */
  async claim(
    endpointId: string,
    deliveryId: string,
    groups: WaiterCandidateGroup[]
  ): Promise<{ decided: boolean; claimed: number; failed: number; ids: string[] }> {
    const e = this.#endpointKeys(endpointId);
    const keys = [
      this.#claimKey(endpointId, deliveryId),
      this.#claimCountsKey(endpointId, deliveryId),
      e.wwst,
      e.wwsx,
    ];
    const args: string[] = [deliveryId];
    for (const group of groups) {
      const w = this.#waiterKeys(endpointId, group.shape, group.values);
      keys.push(w.ww, w.wwf);
      args.push(String(group.ids.length), ...group.ids);
    }
    const reply = await this.client.wwClaim(keys.length, ...keys, ...args);
    return {
      decided: String(reply[0]) === "decided",
      claimed: Number(reply[1]),
      failed: Number(reply[2]),
      ids: reply.slice(3).map(String),
    };
  }

  /** The delivery's claimed waiters that haven't resumed or been given up on yet. */
  async unresolved(endpointId: string, deliveryId: string): Promise<string[]> {
    const members = await this.client.smembers(this.#claimKey(endpointId, deliveryId));
    return members.filter((member) => member !== "__decided__");
  }

  /**
   * Take waiters out of the delivery's claim record: `ok` for resumed ones, `failed` for ones given
   * up on (keeping the first `error`). With no ids it only reads the counts.
   */
  async resolve(
    endpointId: string,
    deliveryId: string,
    mode: "ok" | "failed",
    ids: string[] = [],
    error?: string
  ): Promise<ClaimCounts> {
    const reply = await this.client.wwAck(
      this.#claimKey(endpointId, deliveryId),
      this.#claimCountsKey(endpointId, deliveryId),
      this.#endpointKeys(endpointId).wwe,
      mode,
      error ?? "",
      ...ids
    );
    const firstError = String(reply[3] ?? "");
    return {
      remaining: Math.max(Number(reply[0]), 0),
      claimed: Number(reply[1]),
      failed: Number(reply[2]),
      ...(firstError ? { error: firstError } : {}),
    };
  }

  /** A page of the endpoint's live waiters, soonest expiry first, and how many are live. */
  async listLive(
    endpointId: string,
    now: number,
    offset: number,
    limit: number
  ): Promise<{ waiters: Array<{ id: string; expiresAt: number }>; total: number }> {
    const wwe = this.#endpointKeys(endpointId).wwe;
    const [page, total] = await Promise.all([
      this.client.zrangebyscore(wwe, now, "+inf", "WITHSCORES", "LIMIT", offset, limit),
      this.client.zcount(wwe, now, "+inf"),
    ]);
    const waiters: Array<{ id: string; expiresAt: number }> = [];
    for (let i = 0; i < page.length; i += 2) {
      const id = page[i]!;
      if (!id.startsWith("r:")) waiters.push({ id, expiresAt: Number(page[i + 1]) });
    }
    return { waiters, total };
  }

  async quit() {
    await this.client.quit();
  }
}
