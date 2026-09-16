import { createCache, createMemoryStore, DefaultStatefulContext, Namespace } from "@internal/cache";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { S2RealtimeStreams } from "./s2realtimeStreams.server";

const BASIN = "test-basin";
const STREAM_PREFIX = "org/org_123/env/dev/env_123";

type IssueAccessTokenRequest = {
  id: string;
  scope: {
    basins: { exact: string };
    ops: string[];
    streams: { exact?: string; prefix?: string };
  };
  expires_at: string;
  auto_prefix_streams: boolean;
};

let accountServer: Server;
let accountUrl: string;
let issuedRequests: IssueAccessTokenRequest[] = [];

beforeAll(async () => {
  accountServer = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/access-tokens") {
      response.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    issuedRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));

    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ access_token: `issued-token-${issuedRequests.length}` }));
  });

  await new Promise<void>((resolve) => accountServer.listen(0, "127.0.0.1", resolve));
  const address = accountServer.address() as AddressInfo;
  accountUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    accountServer.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  issuedRequests = [];
});

function createAccessTokenCache() {
  const context = new DefaultStatefulContext();
  return createCache({
    accessToken: new Namespace<string>(context, {
      stores: [createMemoryStore(100, 0)],
      fresh: 60_000,
      stale: 120_000,
    }),
  });
}

function createStreams(options?: {
  cache?: ReturnType<typeof createAccessTokenCache>;
  skipAccessTokens?: boolean;
  accessToken?: string;
}) {
  return new S2RealtimeStreams({
    basin: BASIN,
    accessToken: options?.accessToken ?? "account-token",
    streamPrefix: STREAM_PREFIX,
    accountUrl,
    basinUrl: `${accountUrl}/basins/{basin}`,
    cache: options?.cache,
    skipAccessTokens: options?.skipAccessTokens,
  });
}

describe("S2RealtimeStreams access-token scopes", () => {
  it("scopes the ordinary session input initializer to its exact full stream name", async () => {
    const streams = createStreams();

    const result = await streams.initializeSessionStream("session_123", "in");

    const streamName = `${STREAM_PREFIX}/sessions/session_123/in`;
    expect(result.responseHeaders).toMatchObject({
      "X-S2-Access-Token": "issued-token-1",
      "X-S2-Stream-Name": streamName,
      "X-S2-Basin": BASIN,
    });
    expect(issuedRequests).toHaveLength(1);
    expect(issuedRequests[0]).toMatchObject({
      scope: {
        basins: { exact: BASIN },
        ops: ["append", "create-stream"],
        streams: { exact: streamName },
      },
      auto_prefix_streams: false,
    });
    expect(issuedRequests[0]!.scope.streams).not.toHaveProperty("prefix");
  });

  it("scopes the named session input initializer to only that channel", async () => {
    const streams = createStreams();

    const result = await streams.initializeSessionStream("chat-room", "in", "steering");

    const streamName = `${STREAM_PREFIX}/sessions/chat-room/channels/steering/in`;
    expect(result.responseHeaders?.["X-S2-Stream-Name"]).toBe(streamName);
    expect(issuedRequests[0]).toMatchObject({
      scope: {
        ops: ["append", "create-stream"],
        streams: { exact: streamName },
      },
      auto_prefix_streams: false,
    });
  });

  it("keeps trim authority on an exact private session output stream", async () => {
    const streams = createStreams();

    const result = await streams.initializeSessionStream("session_123", "out", "updates");

    const streamName = `${STREAM_PREFIX}/sessions/session_123/channels/updates/out`;
    expect(result.responseHeaders?.["X-S2-Stream-Name"]).toBe(streamName);
    expect(issuedRequests[0]).toMatchObject({
      scope: {
        ops: ["append", "create-stream", "trim"],
        streams: { exact: streamName },
      },
      auto_prefix_streams: false,
    });
  });

  it("keeps the relative, auto-prefixed contract for run stream writers", async () => {
    const streams = createStreams();

    const result = await streams.initializeStream("run_123", "progress");

    expect(result.responseHeaders?.["X-S2-Stream-Name"]).toBe("/runs/run_123/progress");
    expect(issuedRequests[0]).toMatchObject({
      scope: {
        ops: ["append", "create-stream"],
        streams: { prefix: STREAM_PREFIX },
      },
      auto_prefix_streams: true,
    });
  });

  it("caches each exact scope separately and ignores the previous broad cache namespace", async () => {
    const cache = createAccessTokenCache();
    const previousCacheKey = `${BASIN}:${STREAM_PREFIX}:append,create-stream,trim`;
    await cache.accessToken.set(previousCacheKey, "broad-token");
    const streams = createStreams({ cache });

    const first = await streams.initializeSessionStream("session_123", "in");
    const repeated = await streams.initializeSessionStream("session_123", "in");
    const different = await streams.initializeSessionStream("session_456", "in");

    expect(first.responseHeaders?.["X-S2-Access-Token"]).toBe("issued-token-1");
    expect(repeated.responseHeaders?.["X-S2-Access-Token"]).toBe("issued-token-1");
    expect(different.responseHeaders?.["X-S2-Access-Token"]).toBe("issued-token-2");
    expect(issuedRequests).toHaveLength(2);
  });

  it("returns full stream names when token issuance is disabled", async () => {
    const streams = createStreams({ skipAccessTokens: true, accessToken: "" });

    const ordinary = await streams.initializeSessionStream("session_123", "in");
    const named = await streams.initializeSessionStream("session_123", "in", "steering");

    expect(ordinary.responseHeaders).toMatchObject({
      "X-S2-Access-Token": "s2-skip-access-tokens",
      "X-S2-Stream-Name": `${STREAM_PREFIX}/sessions/session_123/in`,
    });
    expect(named.responseHeaders?.["X-S2-Stream-Name"]).toBe(
      `${STREAM_PREFIX}/sessions/session_123/channels/steering/in`
    );
    expect(issuedRequests).toHaveLength(0);
  });
});
