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

describe.skipIf(process.env.GITHUB_ACTIONS)("BatchStreamGrants", () => {
  redisTest("spends exactly the granted number of attempts", async ({ redisOptions }) => {
    const grants = new BatchStreamGrants({
      redis: { ...redisOptions, tlsDisabled: true },
      attempts: 3,
      ttlMs: 60_000,
    });

    try {
      await grants.mint("batch_spend");

      expect(await grants.spend("batch_spend")).toBe(true);
      expect(await grants.spend("batch_spend")).toBe(true);
      expect(await grants.spend("batch_spend")).toBe(true);
      expect(await grants.spend("batch_spend")).toBe(false);
      expect(await grants.spend("batch_spend")).toBe(false);
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
      expect(await grants.spend("batch_never_minted")).toBe(false);
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
      await grants.mint("batch_a");
      await grants.mint("batch_b");

      expect(await grants.spend("batch_a")).toBe(true);
      expect(await grants.spend("batch_a")).toBe(false);
      expect(await grants.spend("batch_b")).toBe(true);
    } finally {
      await grants.quit();
    }
  });

  redisTest("expires the grant so it cannot outlive the seal window", async ({ redisOptions }) => {
    const grants = new BatchStreamGrants({
      redis: { ...redisOptions, tlsDisabled: true },
      attempts: 5,
      ttlMs: 150,
    });

    try {
      await grants.mint("batch_expiring");
      expect(await grants.spend("batch_expiring")).toBe(true);

      await vi.waitFor(
        async () => {
          expect(await grants.spend("batch_expiring")).toBe(false);
        },
        { timeout: 5_000, interval: 50 }
      );
    } finally {
      await grants.quit();
    }
  });
});
