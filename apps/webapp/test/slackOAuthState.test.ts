import { redisTest } from "@internal/testcontainers";
import Redis from "ioredis";
import { describe, expect, vi } from "vitest";
import {
  clearSlackOAuthSessionBinding,
  consumeSlackOAuthStateForSession,
  createSlackOAuthStateForSession,
  SlackOAuthStateStore,
} from "../app/models/slackOAuthState.server.js";

vi.setConfig({ testTimeout: 30_000 });

const state = {
  userId: "user_123",
  sessionBinding: "session_123",
  organizationId: "org_123",
  service: "slack" as const,
  redirectTo: "/orgs/acme/projects/app/env/prod/alerts/new/connect-to-slack",
};

const expectedState = {
  userId: state.userId,
  sessionBinding: state.sessionBinding,
  service: state.service,
};

const keyForNonce = (nonce: string) => `oauth:slack:state:{${nonce}}`;

describe("SlackOAuthStateStore", () => {
  redisTest(
    "creates a cryptographically random, expiring state value",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);

      try {
        const store = new SlackOAuthStateStore(redis);
        const nonce = await store.create(state);

        expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        await expect(redis.get(keyForNonce(nonce))).resolves.toBe(JSON.stringify(state));
        const ttl = await redis.ttl(keyForNonce(nonce));
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(600);
      } finally {
        redis.disconnect();
      }
    }
  );

  redisTest(
    "atomically accepts one matching callback and rejects concurrent replays",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);

      try {
        const store = new SlackOAuthStateStore(redis);
        const nonce = await store.create(state);
        const results = await Promise.all([
          store.consume(nonce, expectedState),
          store.consume(nonce, expectedState),
        ]);

        expect(results.filter((result) => result !== undefined)).toEqual([state]);
        expect(results.filter((result) => result === undefined)).toHaveLength(1);
      } finally {
        redis.disconnect();
      }
    }
  );

  redisTest("rejects mismatched state without consuming it", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const mismatches = [
      { userId: "user_456", sessionBinding: state.sessionBinding, service: "slack" },
      { userId: state.userId, sessionBinding: "session_456", service: "slack" },
      { userId: state.userId, sessionBinding: state.sessionBinding, service: "vercel" },
    ];

    try {
      const store = new SlackOAuthStateStore(redis);

      for (const mismatch of mismatches) {
        const nonce = await store.create(state);
        await expect(store.consume(nonce, mismatch as any)).resolves.toBeUndefined();
        await expect(store.consume(nonce, expectedState)).resolves.toEqual(state);
      }
    } finally {
      redis.disconnect();
    }
  });

  redisTest("rejects missing state and malformed nonces", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    try {
      const store = new SlackOAuthStateStore(redis);
      const nonce = await store.create(state);
      await redis.del(keyForNonce(nonce));

      await expect(store.consume(nonce, expectedState)).resolves.toBeUndefined();
      await expect(store.consume("malformed-state", expectedState)).resolves.toBeUndefined();
    } finally {
      redis.disconnect();
    }
  });

  redisTest("rejects corrupt stored state", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    try {
      const store = new SlackOAuthStateStore(redis);
      const nonce = "a".repeat(43);
      await redis.set(keyForNonce(nonce), "{not-json", "EX", 600);

      await expect(store.consume(nonce, expectedState)).resolves.toBeUndefined();
    } finally {
      redis.disconnect();
    }
  });

  redisTest("rejects protocol-relative return paths", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    try {
      const store = new SlackOAuthStateStore(redis);
      await expect(store.create({ ...state, redirectTo: "//example.com" })).rejects.toThrow();
    } finally {
      redis.disconnect();
    }
  });

  redisTest("binds callbacks to the initiating browser session", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    try {
      const store = new SlackOAuthStateStore(redis);
      const stateWithoutBinding = {
        userId: state.userId,
        organizationId: state.organizationId,
        service: state.service,
        redirectTo: state.redirectTo,
      };
      const first = await createSlackOAuthStateForSession(
        new Request("https://example.com/connect"),
        stateWithoutBinding,
        store
      );
      const second = await createSlackOAuthStateForSession(
        new Request("https://example.com/connect"),
        stateWithoutBinding,
        store
      );
      const firstCookie = first.sessionCookie.split(";", 1)[0];
      const secondCookie = second.sessionCookie.split(";", 1)[0];
      const requestWithCookie = (cookie?: string) =>
        new Request("https://example.com/integrations/slack/callback", {
          headers: cookie ? { Cookie: cookie } : undefined,
        });

      await expect(
        consumeSlackOAuthStateForSession(requestWithCookie(), first.nonce, state.userId, store)
      ).resolves.toBeUndefined();
      await expect(
        consumeSlackOAuthStateForSession(
          requestWithCookie(secondCookie),
          first.nonce,
          state.userId,
          store
        )
      ).resolves.toBeUndefined();

      const consumedState = await consumeSlackOAuthStateForSession(
        requestWithCookie(firstCookie),
        first.nonce,
        state.userId,
        store
      );
      expect(consumedState).toMatchObject({
        userId: state.userId,
        organizationId: state.organizationId,
        service: state.service,
        redirectTo: state.redirectTo,
        sessionBinding: expect.any(String),
      });

      const clearedCookie = (
        await clearSlackOAuthSessionBinding(requestWithCookie(firstCookie))
      ).split(";", 1)[0];
      const staleNonce = await store.create({
        ...state,
        sessionBinding: consumedState!.sessionBinding,
      });
      await expect(
        consumeSlackOAuthStateForSession(
          requestWithCookie(clearedCookie),
          staleNonce,
          state.userId,
          store
        )
      ).resolves.toBeUndefined();
    } finally {
      redis.disconnect();
    }
  });
});
