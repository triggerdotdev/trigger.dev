import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = process.env;

const requiredEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  DIRECT_URL: "postgresql://test:test@localhost:5432/test",
  SESSION_SECRET: "test-session-secret",
  MAGIC_LINK_SECRET: "test-magic-link-secret",
  ENCRYPTION_KEY: "test-encryption-keeeeey-32-bytes",
  CLICKHOUSE_URL: "http://localhost:8123",
  DEPLOY_REGISTRY_HOST: "registry.example.com",
  MANAGED_WORKER_SECRET: "test-managed-worker-secret",
};

describe("webapp environment secrets", () => {
  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it.each(["SESSION_SECRET", "MAGIC_LINK_SECRET", "ENCRYPTION_KEY", "MANAGED_WORKER_SECRET"])(
    "requires %s to be explicitly set",
    async (key) => {
      process.env = { ...requiredEnv };
      delete process.env[key];

      await expect(import("../app/env.server")).rejects.toThrow(key);
    }
  );

  it.each(["SESSION_SECRET", "MAGIC_LINK_SECRET", "ENCRYPTION_KEY", "MANAGED_WORKER_SECRET"])(
    "rejects an empty %s",
    async (key) => {
      process.env = { ...requiredEnv, [key]: "" };

      await expect(import("../app/env.server")).rejects.toThrow(key);
    }
  );

  it.each([
    ["SESSION_SECRET", "2818143646516f6fffd707b36f334bbb"],
    ["MAGIC_LINK_SECRET", "44da78b7bbb0dfe709cf38931d25dcdd"],
    ["ENCRYPTION_KEY", "f686147ab967943ebbe9ed3b496e465a"],
    ["MANAGED_WORKER_SECRET", "managed-secret"],
    ["MANAGED_WORKER_SECRET", "447c29678f9eaf289e9c4b70d3dd8a7f"],
  ])("rejects the known-insecure default value for %s", async (key, insecureValue) => {
    process.env = { ...requiredEnv, [key]: insecureValue };

    await expect(import("../app/env.server")).rejects.toThrow(key);
  });

  it("accepts explicitly configured secrets", async () => {
    process.env = { ...requiredEnv };

    const { env } = await import("../app/env.server");

    expect(env.SESSION_SECRET).toBe(requiredEnv.SESSION_SECRET);
    expect(env.MAGIC_LINK_SECRET).toBe(requiredEnv.MAGIC_LINK_SECRET);
    expect(env.ENCRYPTION_KEY).toBe(requiredEnv.ENCRYPTION_KEY);
    expect(env.MANAGED_WORKER_SECRET).toBe(requiredEnv.MANAGED_WORKER_SECRET);
  });

  it("allows a known-insecure default when ALLOW_INSECURE_DEFAULT_SECRETS is set", async () => {
    process.env = {
      ...requiredEnv,
      ALLOW_INSECURE_DEFAULT_SECRETS: "1",
      ENCRYPTION_KEY: "f686147ab967943ebbe9ed3b496e465a",
      MANAGED_WORKER_SECRET: "managed-secret",
    };

    const { env } = await import("../app/env.server");

    expect(env.ENCRYPTION_KEY).toBe("f686147ab967943ebbe9ed3b496e465a");
    expect(env.MANAGED_WORKER_SECRET).toBe("managed-secret");
  });

  it("still rejects an empty secret even with ALLOW_INSECURE_DEFAULT_SECRETS", async () => {
    process.env = { ...requiredEnv, ALLOW_INSECURE_DEFAULT_SECRETS: "1", SESSION_SECRET: "" };

    await expect(import("../app/env.server")).rejects.toThrow("SESSION_SECRET");
  });
});
