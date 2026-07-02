import { describe, expect, it } from "vitest";
import {
  ControlPlaneCache,
  type ResolvedAuthenticatedEnv,
  type ResolvedEnv,
  type ResolvedRunLockedWorker,
  type ResolvedWorkerVersion,
} from "./controlPlaneCache.server";

// Minimal, structurally-irrelevant stand-ins: the cache stores and returns opaque values by
// reference, so these only need to be distinguishable objects — the slot types are exercised for
// key routing, not field shape.
const anEnv = { id: "env_1" } as unknown as ResolvedEnv;
const aVersion = { worker: { id: "bw_1" } } as unknown as ResolvedWorkerVersion;
const anAuthEnv = { id: "env_1", slug: "prod" } as unknown as ResolvedAuthenticatedEnv;
const aLockedWorker = { lockedBy: null, lockedToVersion: null } as ResolvedRunLockedWorker;

describe("ControlPlaneCache", () => {
  it("round-trips a value through every slot", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    cache.setEnv("env_1", anEnv);
    cache.setWorkerVersion("env_1:current", aVersion);
    cache.setEnvExists("env_1", true);
    cache.setAuthEnv("env_1", anAuthEnv);
    cache.setLockedWorker("bw_1:v_1", aLockedWorker);

    expect(cache.getEnv("env_1")).toBe(anEnv);
    expect(cache.getWorkerVersion("env_1:current")).toBe(aVersion);
    expect(cache.getEnvExists("env_1")).toBe(true);
    expect(cache.getAuthEnv("env_1")).toBe(anAuthEnv);
    expect(cache.getLockedWorker("bw_1:v_1")).toBe(aLockedWorker);
  });

  it("returns undefined for a key that was never set, in every slot", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    expect(cache.getEnv("missing")).toBeUndefined();
    expect(cache.getWorkerVersion("missing")).toBeUndefined();
    expect(cache.getEnvExists("missing")).toBeUndefined();
    expect(cache.getAuthEnv("missing")).toBeUndefined();
    expect(cache.getLockedWorker("missing")).toBeUndefined();
  });

  it("distinguishes a cached null (confirmed absence) from an unset miss", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    expect(cache.getEnv("env_2")).toBeUndefined();
    cache.setEnv("env_2", null);
    expect(cache.getEnv("env_2")).toBeNull();

    expect(cache.getAuthEnv("env_2")).toBeUndefined();
    cache.setAuthEnv("env_2", null);
    expect(cache.getAuthEnv("env_2")).toBeNull();

    expect(cache.getWorkerVersion("env_2:current")).toBeUndefined();
    cache.setWorkerVersion("env_2:current", null);
    expect(cache.getWorkerVersion("env_2:current")).toBeNull();

    expect(cache.getLockedWorker("_:_")).toBeUndefined();
    cache.setLockedWorker("_:_", null);
    expect(cache.getLockedWorker("_:_")).toBeNull();
  });

  it("caches a false env-existence result distinctly from an unset miss", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    expect(cache.getEnvExists("env_3")).toBeUndefined();
    cache.setEnvExists("env_3", false);
    expect(cache.getEnvExists("env_3")).toBe(false);
  });

  it("invalidateEnv forces the next getEnv to miss", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    cache.setEnv("env_4", anEnv);
    expect(cache.getEnv("env_4")).toBe(anEnv);

    cache.invalidateEnv("env_4");
    expect(cache.getEnv("env_4")).toBeUndefined();
  });

  it("makes a re-setEnv after invalidation readable again", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const replacement = { id: "env_5b" } as unknown as ResolvedEnv;

    cache.setEnv("env_5", anEnv);
    cache.invalidateEnv("env_5");
    expect(cache.getEnv("env_5")).toBeUndefined();

    cache.setEnv("env_5", replacement);
    expect(cache.getEnv("env_5")).toBe(replacement);
  });

  it("invalidateEnv is scoped to its own id", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const other = { id: "env_keep" } as unknown as ResolvedEnv;

    cache.setEnv("env_drop", anEnv);
    cache.setEnv("env_keep", other);
    cache.invalidateEnv("env_drop");

    expect(cache.getEnv("env_drop")).toBeUndefined();
    expect(cache.getEnv("env_keep")).toBe(other);
  });

  it("does not collide keys across slots for the same id", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    cache.setEnv("x", anEnv);
    cache.setEnvExists("x", true);
    cache.setAuthEnv("x", anAuthEnv);

    expect(cache.getEnv("x")).toBe(anEnv);
    expect(cache.getEnvExists("x")).toBe(true);
    expect(cache.getAuthEnv("x")).toBe(anAuthEnv);

    // Invalidating the env slot leaves the sibling slots for the same id intact.
    cache.invalidateEnv("x");
    expect(cache.getEnv("x")).toBeUndefined();
    expect(cache.getEnvExists("x")).toBe(true);
    expect(cache.getAuthEnv("x")).toBe(anAuthEnv);
  });

  it("evicts the oldest entry once maxEntries is exceeded", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 2 });

    cache.setEnv("first", { id: "first" } as unknown as ResolvedEnv);
    cache.setEnv("second", { id: "second" } as unknown as ResolvedEnv);
    cache.setEnv("third", { id: "third" } as unknown as ResolvedEnv);

    expect(cache.getEnv("first")).toBeUndefined();
    expect(cache.getEnv("second")).toMatchObject({ id: "second" });
    expect(cache.getEnv("third")).toMatchObject({ id: "third" });
  });

  it("treats a zero-TTL entry as immediately expired", () => {
    const cache = new ControlPlaneCache({ ttlMs: 0, maxEntries: 100 });

    cache.setEnv("env_ttl", anEnv);
    expect(cache.getEnv("env_ttl")).toBeUndefined();
  });
});
