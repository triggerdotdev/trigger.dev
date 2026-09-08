import { describe, expect, it } from "vitest";
import {
  buildPrismaConnectionUrl,
  connectionLifetimePoolOptions,
  resolveConnectionLifetimeSeconds,
} from "./prismaConnectionUrl";

describe("buildPrismaConnectionUrl", () => {
  it("sets connect_timeout (the Postgres connector parameter), not the ignored connection_timeout", () => {
    const url = buildPrismaConnectionUrl("postgresql://u:p@host:5432/db?schema=public", {
      connectionLimit: "10",
      poolTimeout: "0",
      connectTimeout: "20",
      applicationName: "svc",
    });

    expect(url.searchParams.get("connect_timeout")).toBe("20");
    expect(url.searchParams.has("connection_timeout")).toBe(false);
    expect(url.searchParams.get("connection_limit")).toBe("10");
    expect(url.searchParams.get("pool_timeout")).toBe("0");
    expect(url.searchParams.get("application_name")).toBe("svc");
  });

  it("preserves existing base query params", () => {
    const url = buildPrismaConnectionUrl(
      "postgresql://u:p@host:5432/db?schema=public&sslmode=require",
      { connectionLimit: "5", poolTimeout: "10", connectTimeout: "20", applicationName: "svc" }
    );

    expect(url.searchParams.get("schema")).toBe("public");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("connect_timeout")).toBe("20");
  });

  // The inertness guard: with the lifetime unconfigured the DSN must be exactly
  // what it was before this parameter existed. Make the searchParams.set
  // unconditional and this goes red on the literal string "undefined".
  it("omits max_connection_lifetime entirely when it is not configured", () => {
    const base = { connectionLimit: "5", poolTimeout: "10", connectTimeout: "20" };

    const withoutKey = buildPrismaConnectionUrl(
      "postgresql://u:p@host:5432/db?schema=public&sslmode=require",
      { ...base, applicationName: "svc" }
    );
    const withUndefined = buildPrismaConnectionUrl(
      "postgresql://u:p@host:5432/db?schema=public&sslmode=require",
      { ...base, applicationName: "svc", maxConnectionLifetime: undefined }
    );

    expect(withoutKey.searchParams.has("max_connection_lifetime")).toBe(false);
    expect(withUndefined.searchParams.has("max_connection_lifetime")).toBe(false);
    expect(withUndefined.href).toBe(withoutKey.href);
    expect(withoutKey.href).toBe(
      "postgresql://u:p@host:5432/db?schema=public&sslmode=require&connection_limit=5&pool_timeout=10&connect_timeout=20&application_name=svc"
    );
  });

  // Pins the contract as "omit iff undefined": any supplied string is passed
  // through, so the caller decides, not this builder.
  it("passes through an explicitly supplied zero", () => {
    const url = buildPrismaConnectionUrl("postgresql://u:p@host:5432/db", {
      connectionLimit: "5",
      poolTimeout: "10",
      connectTimeout: "20",
      applicationName: "svc",
      maxConnectionLifetime: "0",
    });

    expect(url.searchParams.get("max_connection_lifetime")).toBe("0");
  });

  it("sets max_connection_lifetime when configured", () => {
    const url = buildPrismaConnectionUrl("postgresql://u:p@host:5432/db", {
      connectionLimit: "5",
      poolTimeout: "10",
      connectTimeout: "20",
      applicationName: "svc",
      maxConnectionLifetime: "3600",
    });

    expect(url.searchParams.get("max_connection_lifetime")).toBe("3600");
  });
});

describe("resolveConnectionLifetimeSeconds", () => {
  it.each([
    ["unset", undefined],
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("returns undefined when the base is %s", (_label, base) => {
    expect(resolveConnectionLifetimeSeconds(base, () => 0.5)).toBeUndefined();
  });

  it("returns the base with no jitter at the bottom of the random range", () => {
    expect(resolveConnectionLifetimeSeconds(3600, () => 0)).toBe(3600);
  });

  it("subtracts at most 20% jitter at the top of the random range", () => {
    expect(resolveConnectionLifetimeSeconds(3600, () => 1)).toBe(2880);
  });

  it("clamps an out-of-range random into [base * 0.8, base]", () => {
    expect(resolveConnectionLifetimeSeconds(3600, () => -5)).toBe(3600);
    expect(resolveConnectionLifetimeSeconds(3600, () => 5)).toBe(2880);
    expect(resolveConnectionLifetimeSeconds(3600, () => Number.NaN)).toBe(3600);
  });

  // The configured value is a maximum: an operator may set it just below an
  // upstream cutoff, so jitter must never push a connection past it. Flip the
  // sign in resolveConnectionLifetimeSeconds and this goes red.
  it.each([1, 2, 60, 3600, 82800])("never exceeds the configured cap of %i", (base) => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const resolved = resolveConnectionLifetimeSeconds(base, () => r);
      expect(resolved).toBeLessThanOrEqual(base);
      expect(resolved).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("connectionLifetimePoolOptions", () => {
  // Omitting the key is what keeps an unconfigured deployment inert, so assert
  // absence rather than an undefined value.
  it("omits maxLifetimeSeconds entirely when uncapped", () => {
    const options = connectionLifetimePoolOptions(undefined);

    expect("maxLifetimeSeconds" in options).toBe(false);
    expect(Object.keys(options)).toHaveLength(0);
  });

  it("carries maxLifetimeSeconds when a lifetime is resolved", () => {
    expect(connectionLifetimePoolOptions(3600)).toEqual({ maxLifetimeSeconds: 3600 });
  });
});
