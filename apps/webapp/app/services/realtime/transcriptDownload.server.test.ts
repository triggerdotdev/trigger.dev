import { createServer, type Server } from "node:http";
import { once } from "node:events";
import express from "express";
import { sendRemixResponse } from "@remix-run/express/dist/server";
import { expect, test } from "vitest";
import { minioTest } from "@internal/testcontainers";
import {
  serializeTranscriptSnapshot,
  TRANSCRIPT_BLOB_CONTENT_TYPE,
  type TranscriptSnapshotV2,
} from "@trigger.dev/core/v3";
import { ObjectStoreClient } from "~/v3/objectStoreClient.server";
import { downloadTranscript, isTranscriptNotFound } from "./transcriptDownload.server";

function snapshot(count: number, text = "Saved message 🐙"): TranscriptSnapshotV2 {
  return {
    version: 2,
    savedAt: 1_800_000_000_000,
    lastInEventId: "24",
    lastOutEventId: "99",
    state: {
      runtime: {
        version: 1,
        steeringInjections: [
          {
            messageId: "assistant-1",
            modelMessages: [{ role: "user", content: "Private steering context" }],
          },
        ],
      },
    },
    messages: Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`,
      final: index !== count - 1,
      message: {
        id: `message-${index}`,
        role: index % 2 ? "assistant" : "user",
        parts: [{ type: "text", text }],
      },
    })),
  };
}

const key = "packets/download/snapshot.json";

minioTest(
  "streams indexed snapshots byte for byte, using a .jsonl filename and the stored media type",
  async ({ minioConfig }) => {
    const client = ObjectStoreClient.create({ ...minioConfig, service: "s3" });
    for (const count of [0, 250]) {
      const bytes = Buffer.from(serializeTranscriptSnapshot(snapshot(count, "🐙".repeat(6000))));
      await client.putObject(key, bytes.toString(), TRANSCRIPT_BLOB_CONTENT_TYPE);
      const response = downloadTranscript(
        await client.getObjectResponse(key),
        "s3://sessions/session_123/snapshot.json"
      );
      expect(response.headers.get("Content-Disposition")).toBe(
        'attachment; filename="snapshot.jsonl"'
      );
      expect(response.headers.get("Content-Type")).toBe(TRANSCRIPT_BLOB_CONTENT_TYPE);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
  },
  30_000
);

minioTest(
  "preserves legacy JSON formatting and every original byte without format validation",
  async ({ minioConfig }) => {
    const client = ObjectStoreClient.create({ ...minioConfig, service: "s3" });
    const bodies = [
      Buffer.from('\ufeff  { "version": 1, "messages": [] }\r\n'),
      Buffer.from(JSON.stringify(snapshot(52), null, 4) + "\n"),
      Buffer.from([0, 255, 254, 128, 13, 10]),
      Buffer.alloc(0),
    ];
    for (const bytes of bodies) {
      const upload = await fetch(await client.presign(key, "PUT", 300), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      expect(upload.ok).toBe(true);
      expect(await client.objectExists(key)).toBe(true);
      const response = downloadTranscript(await client.getObjectResponse(key), key);
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
  }
);

minioTest(
  "missing objects remain missing and existing unrecognized files remain downloadable",
  async ({ minioConfig }) => {
    const client = ObjectStoreClient.create({ ...minioConfig, service: "s3" });
    expect(await client.objectExists(key)).toBe(false);
    await expect(client.getObjectResponse(key)).rejects.toSatisfy(isTranscriptNotFound);
    await client.putObject(key, "invalid transcript", "text/plain");
    expect(await client.objectExists(key)).toBe(true);
    const response = downloadTranscript(await client.getObjectResponse(key), key);
    expect(await response.text()).toBe("invalid transcript");
  }
);

test("does not treat permission or service failures as an absent transcript", () => {
  expect(isTranscriptNotFound(new Error("Failed to download from object store: Forbidden"))).toBe(
    false
  );
  expect(
    isTranscriptNotFound(
      new Error("Failed to download range from object store: Internal Server Error")
    )
  ).toBe(false);
  expect(isTranscriptNotFound({ $metadata: { httpStatusCode: 503 } })).toBe(false);
  expect(isTranscriptNotFound({ name: "NoSuchKey" })).toBe(true);
});

minioTest(
  "HEAD distinguishes permission failures from missing objects",
  async ({ minioConfig }) => {
    const client = ObjectStoreClient.create({
      ...minioConfig,
      service: "s3",
      secretAccessKey: "invalid-secret",
    });
    await expect(client.objectExists(key)).rejects.toThrow("Failed to check object store");
  }
);

minioTest(
  "the SDK adapter recognizes empty objects and streams their original bytes",
  async ({ minioConfig }) => {
    const previous = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    };
    process.env.AWS_ACCESS_KEY_ID = minioConfig.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
    delete process.env.AWS_SESSION_TOKEN;
    try {
      const writer = ObjectStoreClient.create({ ...minioConfig, service: "s3" });
      const client = ObjectStoreClient.create({
        baseUrl: minioConfig.baseUrl,
        bucket: "packets",
        region: "us-east-1",
      });
      expect(await client.objectExists(key)).toBe(false);
      for (const body of ["", serializeTranscriptSnapshot(snapshot(2))]) {
        await writer.putObject(key, body, TRANSCRIPT_BLOB_CONTENT_TYPE);
        expect(await client.objectExists(key)).toBe(true);
        const download = downloadTranscript(await client.getObjectResponse(key), key);
        expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(body));
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

test("logs late upstream failures and Remix terminates the incomplete attachment", async () => {
  const source = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": TRANSCRIPT_BLOB_CONTENT_TYPE,
      "Content-Length": "100000",
    });
    response.write('{"v":2}\n');
    setTimeout(() => response.destroy(), 100);
  });
  const sourceUrl = await listen(source);
  const reported: unknown[] = [];
  const adapterErrors: unknown[] = [];
  let finish!: () => void;
  const failed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const app = express();
  app.get("/download", async (_request, response, next) => {
    try {
      const object = await fetch(sourceUrl);
      await sendRemixResponse(
        response,
        downloadTranscript(object, key, (error) => reported.push(error))
      );
    } catch (error) {
      next(error);
    }
  });
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      adapterErrors.push(error);
      response.destroy();
      finish();
    }
  );
  const proxy = createServer(app);
  try {
    const url = await listen(proxy);
    const download = await fetch(`${url}/download`).catch((error) => {
      throw new AggregateError(
        [...adapterErrors, ...reported, error],
        "Download failed before headers"
      );
    });
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="snapshot.jsonl"'
    );
    await expect(download.arrayBuffer()).rejects.toThrow();
    await failed;
    expect(reported).toHaveLength(1);
    expect(adapterErrors).toEqual(reported);
  } finally {
    await close(proxy);
    await close(source);
  }
});
