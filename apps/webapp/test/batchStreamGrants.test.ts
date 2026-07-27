import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

vi.mock("../app/services/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { BatchStreamGrants } from "../app/runEngine/concerns/batchStreamGrants.server.js";

describe("BatchStreamGrants", () => {
  const ENV = "env_1";

  redisTest("spends exactly the granted number of attempts", async ({ redisOptions }) => {
    const grants = new BatchStreamGrants({
      redis: { ...redisOptions, tlsDisabled: true },
      attempts: 3,
      ttlMs: 60_000,
    });

    try {
      await grants.mint(ENV, "batch_spend");

      expect(await grants.spend(ENV, "batch_spend")).toBe(true);
      expect(await grants.spend(ENV, "batch_spend")).toBe(true);
      expect(await grants.spend(ENV, "batch_spend")).toBe(true);
      expect(await grants.spend(ENV, "batch_spend")).toBe(false);
      expect(await grants.spend(ENV, "batch_spend")).toBe(false);
    } finally {
      await grants.quit();
    }
  });

  redisTest("declines a batch that was never granted", async ({ redisOptions }) => {
    const grants = new BatchStreamGrants({
      redis: { ...redisOptions, tlsDisabled: true },
      attempts: 5,
      ttlMs: 60_000,
    });

    try {
      expect(await grants.spend(ENV, "batch_never_minted")).toBe(false);
    } finally {
      await grants.quit();
    }
  });

  redisTest("keeps grants isolated per batch", async ({ redisOptions }) => {
    const grants = new BatchStreamGrants({
      redis: { ...redisOptions, tlsDisabled: true },
      attempts: 1,
      ttlMs: 60_000,
    });

    try {
      await grants.mint(ENV, "batch_a");
      await grants.mint(ENV, "batch_b");

      expect(await grants.spend(ENV, "batch_a")).toBe(true);
      expect(await grants.spend(ENV, "batch_a")).toBe(false);
      expect(await grants.spend(ENV, "batch_b")).toBe(true);
    } finally {
      await grants.quit();
    }
  });

  redisTest("expires the grant so it cannot outlive the seal window", async ({ redisOptions }) => {
    const grants = new BatchStreamGrants({
      redis: { ...redisOptions, tlsDisabled: true },
      attempts: 100_000,
      ttlMs: 150,
    });

    try {
      await grants.mint(ENV, "batch_expiring");
      expect(await grants.spend(ENV, "batch_expiring")).toBe(true);

      await vi.waitFor(
        async () => {
          expect(await grants.spend(ENV, "batch_expiring")).toBe(false);
        },
        { timeout: 5_000, interval: 50 }
      );
    } finally {
      await grants.quit();
    }
  });

  redisTest("another environment cannot spend this batch's grant", async ({ redisOptions }) => {
    const grants = new BatchStreamGrants({
      redis: { ...redisOptions, tlsDisabled: true },
      attempts: 1,
      ttlMs: 60_000,
    });

    try {
      await grants.mint(ENV, "batch_scoped");

      expect(await grants.spend("env_intruder", "batch_scoped")).toBe(false);
      expect(await grants.spend(ENV, "batch_scoped")).toBe(true);
    } finally {
      await grants.quit();
    }
  });
});
