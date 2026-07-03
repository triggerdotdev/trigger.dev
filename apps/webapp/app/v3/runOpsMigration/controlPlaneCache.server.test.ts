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
const anEnv = { id: "env_1", organizationId: "org_1" } as unknown as ResolvedEnv;
const aVersion = { worker: { id: "bw_1" } } as unknown as ResolvedWorkerVersion;
const anAuthEnv = {
  id: "env_1",
  slug: "prod",
  organizationId: "org_1",
} as unknown as ResolvedAuthenticatedEnv;
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

  it("invalidateEnvironment forces the next env/authEnv/envExists read to miss", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    cache.setEnv("env_6", anEnv);
    cache.setAuthEnv("env_6", anAuthEnv);
    cache.setEnvExists("env_6", true);
    expect(cache.getEnv("env_6")).toBe(anEnv);
    expect(cache.getAuthEnv("env_6")).toBe(anAuthEnv);
    expect(cache.getEnvExists("env_6")).toBe(true);

    cache.invalidateEnvironment("env_6");

    expect(cache.getEnv("env_6")).toBeUndefined();
    expect(cache.getAuthEnv("env_6")).toBeUndefined();
    expect(cache.getEnvExists("env_6")).toBeUndefined();
  });

  it("invalidateEnvironment is scoped to its own id", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const keepEnv = { id: "env_keep", organizationId: "org_1" } as unknown as ResolvedEnv;

    cache.setEnv("env_drop", anEnv);
    cache.setEnv("env_keep", keepEnv);
    cache.invalidateEnvironment("env_drop");

    expect(cache.getEnv("env_drop")).toBeUndefined();
    expect(cache.getEnv("env_keep")).toBe(keepEnv);
  });

  it("invalidateOrganization drops env/authEnv rows for that org across every env id", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const envA = { id: "env_a", organizationId: "org_1" } as unknown as ResolvedEnv;
    const envB = { id: "env_b", organizationId: "org_1" } as unknown as ResolvedEnv;
    const authA = {
      id: "env_a",
      slug: "a",
      organizationId: "org_1",
    } as unknown as ResolvedAuthenticatedEnv;

    cache.setEnv("env_a", envA);
    cache.setEnv("env_b", envB);
    cache.setAuthEnv("env_a", authA);
    expect(cache.getEnv("env_a")).toBe(envA);
    expect(cache.getEnv("env_b")).toBe(envB);
    expect(cache.getAuthEnv("env_a")).toBe(authA);

    cache.invalidateOrganization("org_1");

    // Every env/authEnv row for org_1 misses — no reverse org->env index required.
    expect(cache.getEnv("env_a")).toBeUndefined();
    expect(cache.getEnv("env_b")).toBeUndefined();
    expect(cache.getAuthEnv("env_a")).toBeUndefined();
  });

  it("invalidateOrganization does not affect a different org's cached envs", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const otherOrgEnv = { id: "env_other", organizationId: "org_2" } as unknown as ResolvedEnv;

    cache.setEnv("env_1", anEnv); // org_1
    cache.setEnv("env_other", otherOrgEnv); // org_2

    cache.invalidateOrganization("org_1");

    expect(cache.getEnv("env_1")).toBeUndefined();
    expect(cache.getEnv("env_other")).toBe(otherOrgEnv);
  });

  it("re-setting an env after an org invalidation makes it readable again", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    cache.setEnv("env_1", anEnv);
    cache.invalidateOrganization("org_1");
    expect(cache.getEnv("env_1")).toBeUndefined();

    // A write after the bump stamps the new org epoch, so it reads back.
    cache.setEnv("env_1", anEnv);
    expect(cache.getEnv("env_1")).toBe(anEnv);
  });

  it("a cached null env survives an org invalidation (a confirmed absence carries no org)", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });

    cache.setEnv("env_absent", null);
    expect(cache.getEnv("env_absent")).toBeNull();

    cache.invalidateOrganization("org_1");

    expect(cache.getEnv("env_absent")).toBeNull();
  });
});
