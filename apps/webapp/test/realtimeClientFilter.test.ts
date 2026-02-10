import { describe, test, expect, vi, beforeEach } from "vitest";
import { RealtimeClient } from "../app/services/realtimeClient.server";

// Hoist mocks
const mocks = vi.hoisted(() => ({
    longPollingFetch: vi.fn(),
    createRedisClient: vi.fn(() => ({
        defineCommand: vi.fn(),
        on: vi.fn(),
    })),
}));

vi.mock("~/utils/longPollingFetch", () => ({
    longPollingFetch: mocks.longPollingFetch,
}));

vi.mock("~/redis.server", () => ({
    createRedisClient: mocks.createRedisClient,
}));

vi.mock("../app/services/unkey/redisCacheStore.server", () => ({
    RedisCacheStore: vi.fn(),
}));

vi.mock("@unkey/cache", () => ({
    createCache: vi.fn(() => ({
        get: vi.fn(),
        set: vi.fn(),
    })),
    DefaultStatefulContext: vi.fn(),
    Namespace: vi.fn(),
}));

// Mock env.server to set the limit to 30 days
vi.mock("~/env.server", () => ({
    env: {
        REALTIME_MAXIMUM_CREATED_AT_FILTER_AGE_IN_MS: 30 * 24 * 60 * 60 * 1000,
    },
}));

describe("RealtimeClient Filter Logic", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.longPollingFetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Map(),
            json: async () => [],
            text: async () => "",
        });
    });

    test("should allow createdAt filter > 24h (e.g. 8d)", async () => {
        const client = new RealtimeClient({
            electricOrigin: "http://electric",
            redis: { host: "localhost", port: 6379, tlsDisabled: true } as any,
            keyPrefix: "test",
            cachedLimitProvider: { getCachedLimit: async () => 100 },
        });

        // Request 8 days ago
        await client.streamRuns(
            "http://remix-app",
            { id: "env-1", organizationId: "org-1" },
            { createdAt: "8d" },
            "2024-01-01"
        );

        const callArgs = mocks.longPollingFetch.mock.calls[0];
        const urlToCheck = callArgs[0] as string;
        const url = new URL(urlToCheck);
        const where = url.searchParams.get("where");

        // Check for "createdAt" > '...'
        const match = where?.match(/"createdAt" > '([^']+)'/);
        expect(match).toBeTruthy();

        const dateStr = match?.[1];
        const date = new Date(dateStr!);

        const now = Date.now();
        const diff = now - date.getTime();
        const days = diff / (24 * 60 * 60 * 1000);

        // It should be close to 8 days.
        expect(days).toBeCloseTo(8, 0); // 0 digits precision is enough (e.g. 7.99 or 8.01)
        expect(days).toBeGreaterThan(7.9);
        expect(days).toBeLessThan(8.1);
    });

    test("should clamp createdAt filter > 30d", async () => {
        const client = new RealtimeClient({
            electricOrigin: "http://electric",
            redis: { host: "localhost", port: 6379, tlsDisabled: true } as any,
            keyPrefix: "test",
            cachedLimitProvider: { getCachedLimit: async () => 100 },
        });

        // Request 60 days ago
        await client.streamRuns(
            "http://remix-app",
            { id: "env-1", organizationId: "org-1" },
            { createdAt: "60d" },
            "2024-01-01"
        );

        const callArgs = mocks.longPollingFetch.mock.calls[0];
        const urlToCheck = callArgs[0] as string;
        const url = new URL(urlToCheck);
        const where = url.searchParams.get("where");

        const match = where?.match(/"createdAt" > '([^']+)'/);
        expect(match).toBeTruthy();

        const dateStr = match?.[1];
        const date = new Date(dateStr!);

        const now = Date.now();
        const diff = now - date.getTime();
        const days = diff / (24 * 60 * 60 * 1000);

        // It should be clamped to 30 days.
        expect(days).toBeCloseTo(30, 0);
        expect(days).toBeGreaterThan(29.9);
        expect(days).toBeLessThan(30.1);
    });
});
