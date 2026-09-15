import { MinIOContainer, type StartedMinIOContainer } from "@internal/testcontainers";
import type { TestServer } from "@internal/testcontainers/webapp";
import { startTestServer } from "@internal/testcontainers/webapp";
import {
  chatSnapshotKeySuffix,
  serializeTranscriptSnapshot,
  TRANSCRIPT_BLOB_CONTENT_TYPE,
} from "@trigger.dev/core/v3";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AwsClient } from "aws4fetch";
import { seedTestApiSession } from "./helpers/seedTestApiSession";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let server: TestServer;
let minio: StartedMinIOContainer;
let objectStore: { baseUrl: string; client: AwsClient };

/**
 * Write an object the way the webapp's own client addresses it: the logical key
 * already begins with the bucket segment, so the URL is `{base}/{key}`.
 */
async function putObject(
  location: { slug: string; project: { externalRef: string } },
  friendlyId: string,
  body: string,
  contentType: string
) {
  const key = `packets/${location.project.externalRef}/${location.slug}/${chatSnapshotKeySuffix(friendlyId)}`;
  const res = await objectStore.client.fetch(`${objectStore.baseUrl}/${key}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${key} failed with ${res.status}`);
}

beforeAll(async () => {
  minio = await new MinIOContainer().start();
  const config = minio.getConnectionConfig();
  objectStore = {
    baseUrl: config.baseUrl,
    client: new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      service: "s3",
    }),
  };

  server = await startTestServer({
    extraEnv: {
      OBJECT_STORE_BASE_URL: config.baseUrl,
      OBJECT_STORE_BUCKET: "packets",
      OBJECT_STORE_ACCESS_KEY_ID: config.accessKeyId,
      OBJECT_STORE_SECRET_ACCESS_KEY: config.secretAccessKey,
      OBJECT_STORE_REGION: config.region,
    },
  });
}, 240_000);

afterAll(async () => {
  await server?.stop();
  await minio?.stop();
}, 120_000);

/**
 * The private runtime state a `chat.agent` run persists alongside the
 * transcript: the compacted model lane, server-injected context, and
 * `chat.inject` messages queued but not yet drained.
 */
const RUNTIME_STATE = {
  v: 1,
  compaction: {
    throughId: "u-1",
    modelMessages: [{ role: "system", content: "PROPRIETARY-COMPACTED-LANE" }],
  },
  injections: [{ afterId: "u-1", messages: [{ role: "system", content: "SERVER-INJECTED" }] }],
  queued: [{ role: "user", content: "QUEUED-NOT-DRAINED" }],
};

async function setupSession() {
  const seed = await seedTestEnvironment(server.prisma);
  const session = await seedTestApiSession(server.prisma, seed.environment);

  const publicToken = await generateJWT({
    secretKey: seed.apiKey,
    payload: {
      pub: true,
      sub: seed.environment.id,
      scopes: [`read:sessions:${session.friendlyId}`, `write:sessions:${session.friendlyId}`],
    },
    expirationTime: "15m",
  });

  return { ...seed, session, publicToken };
}

function entry(id: string, role: "user" | "assistant") {
  return {
    id,
    final: true,
    message: { id, role, parts: [{ type: "text", text: `body of ${id}` }] } as never,
  };
}

/** Write a transcript in the format the SDK now writes: line-based, indexed. */
async function writeSnapshot(
  environment: { slug: string; project: { externalRef: string } },
  friendlyId: string,
  ids: Array<[string, "user" | "assistant"]> = [
    ["u-1", "user"],
    ["a-1", "assistant"],
  ]
) {
  await putObject(
    environment,
    friendlyId,
    serializeTranscriptSnapshot({
      version: 2,
      savedAt: 1_700_000_000_000,
      messages: ids.map(([id, role]) => entry(id, role)),
      state: RUNTIME_STATE,
      lastOutEventId: "evt-42",
    }),
    TRANSCRIPT_BLOB_CONTENT_TYPE
  );
}

/** Write the version 1 blob a released SDK produces. */
async function writeV1Snapshot(
  environment: { slug: string; project: { externalRef: string } },
  friendlyId: string
) {
  await putObject(
    environment,
    friendlyId,
    JSON.stringify({
      version: 1,
      savedAt: 1_700_000_000_000,
      messages: [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "legacy" }] },
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "legacy" }] },
      ],
      lastOutEventId: "evt-1",
    }),
    "application/json"
  );
}

describe("chat snapshot read surfaces do not expose private runtime state", () => {
  describe("GET /api/v1/sessions/:session/snapshot-url", () => {
    const get = (sessionId: string, token: string) =>
      server.webapp.fetch(`/api/v1/sessions/${sessionId}/snapshot-url`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    it("rejects a scoped public session token", async () => {
      const { session, publicToken } = await setupSession();

      const response = await get(session.friendlyId, publicToken);

      expect(response.status).toBe(401);
    });

    it("still presigns for the private runtime key", async () => {
      const { apiKey, session } = await setupSession();

      const response = await get(session.friendlyId, apiKey);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ presignedUrl: expect.any(String) });
    });
  });

  describe("GET /api/v1/sessions/:session/transcript", () => {
    const fetchTranscript = (friendlyId: string, apiKey: string, query = "") =>
      server.webapp.fetch(`/api/v1/sessions/${friendlyId}/transcript${query}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

    it("pages a long transcript and never returns the runtime state", async () => {
      const { apiKey, environment, project, session } = await setupSession();
      const ids = Array.from(
        { length: 40 },
        (_, i) => [`m-${i}`, i % 2 ? "assistant" : "user"] as [string, "user" | "assistant"]
      );
      await writeSnapshot({ slug: environment.slug, project }, session.friendlyId, ids);

      const first = await fetchTranscript(session.friendlyId, apiKey, "?limit=5");
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as Record<string, any>;

      expect(firstBody.messages.map((m: { id: string }) => m.id)).toEqual([
        "m-35",
        "m-36",
        "m-37",
        "m-38",
        "m-39",
      ]);
      expect(firstBody.nextCursor).toBe("m-35");
      expect(firstBody.cursors).toEqual({ lastOutEventId: "evt-42" });
      expect(firstBody.state).toBeNull();
      expect(JSON.stringify(firstBody)).not.toContain("PROPRIETARY-COMPACTED-LANE");

      const second = await fetchTranscript(
        session.friendlyId,
        apiKey,
        `?limit=5&before=${firstBody.nextCursor}`
      );
      const secondBody = (await second.json()) as Record<string, any>;

      expect(secondBody.messages.map((m: { id: string }) => m.id)).toEqual([
        "m-30",
        "m-31",
        "m-32",
        "m-33",
        "m-34",
      ]);
      expect(secondBody.state).toBeNull();
      expect(JSON.stringify(secondBody)).not.toContain("SERVER-INJECTED");
    });

    it("falls back to a full read when the stored media type is not the indexed format", async () => {
      const { apiKey, environment, project, session } = await setupSession();
      // Right bytes, wrong label: the ranged path must decline and the full
      // read must still return the conversation.
      await putObject(
        { slug: environment.slug, project },
        session.friendlyId,
        serializeTranscriptSnapshot({
          version: 2,
          savedAt: 1_700_000_000_000,
          messages: [entry("u-1", "user"), entry("a-1", "assistant")],
          state: RUNTIME_STATE,
          lastOutEventId: "evt-42",
        }),
        "application/json"
      );

      const response = await fetchTranscript(session.friendlyId, apiKey);

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["u-1", "a-1"]);
      expect(body.state).toBeNull();
      expect(JSON.stringify(body)).not.toContain("PROPRIETARY-COMPACTED-LANE");
    });

    it("still reads a version 1 transcript written by a released SDK", async () => {
      const { apiKey, environment, project, session } = await setupSession();
      await writeV1Snapshot({ slug: environment.slug, project }, session.friendlyId);

      const response = await fetchTranscript(session.friendlyId, apiKey);

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["u-1", "a-1"]);
      expect(body.cursors).toEqual({ lastOutEventId: "evt-1" });
      expect(body.state).toBeNull();
    });

    it("returns the transcript without the runtime state", async () => {
      const { apiKey, environment, project, session } = await setupSession();
      await writeSnapshot({ slug: environment.slug, project }, session.friendlyId);

      const response = await server.webapp.fetch(
        `/api/v1/sessions/${session.friendlyId}/transcript`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;

      expect((body.messages as unknown[]).map((m) => (m as { id: string }).id)).toEqual([
        "u-1",
        "a-1",
      ]);
      expect(body.cursors).toEqual({ lastOutEventId: "evt-42" });
      expect(body.state).toBeNull();
      expect(JSON.stringify(body)).not.toContain("PROPRIETARY-COMPACTED-LANE");
      expect(JSON.stringify(body)).not.toContain("SERVER-INJECTED");
      expect(JSON.stringify(body)).not.toContain("QUEUED-NOT-DRAINED");
    });
  });
});
