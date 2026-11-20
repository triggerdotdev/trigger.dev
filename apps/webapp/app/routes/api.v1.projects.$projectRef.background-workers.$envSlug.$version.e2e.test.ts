import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { seedTestUserProject } from "../../test/helpers/seedTestUserProject";

let server: TestServer;
let fixture: Awaited<ReturnType<typeof seedWorkerSource>>;

const MiB = 1024 * 1024;

beforeAll(async () => {
  server = await startTestServer({
    extraEnv: {
      WORKER_SOURCE_FILE_MAX_INFLATED_BYTES: String(8 * MiB),
      WORKER_SOURCE_MAX_TOTAL_INFLATED_BYTES: String(32 * MiB),
    },
  });
  fixture = await seedWorkerSource();
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

async function seedWorkerSource() {
  const seed = await seedTestUserProject(server.prisma);
  const member = await server.prisma.orgMember.findFirstOrThrow({
    where: { organizationId: seed.organization.id, userId: seed.user.id },
  });
  await server.prisma.runtimeEnvironment.update({
    where: { id: seed.environment.id },
    data: { orgMemberId: member.id },
  });

  const oat = `tr_oat_${randomBytes(20).toString("hex")}`;
  await server.prisma.organizationAccessToken.create({
    data: {
      name: "worker-source-test",
      organizationId: seed.organization.id,
      hashedToken: createHash("sha256").update(oat).digest("hex"),
    },
  });

  const source = 'export const task = "worker source";';
  const worker = await server.prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${randomBytes(8).toString("hex")}`,
      engine: "V2",
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
      version: "20261009.1",
      contentHash: "worker-source-hash",
      metadata: {},
      files: {
        create: {
          friendlyId: `file_${randomBytes(8).toString("hex")}`,
          projectId: seed.project.id,
          filePath: "src/task.ts",
          contentHash: "file-source-hash",
          contents: Buffer.from(deflateSync(source).toString("base64")),
        },
      },
    },
  });

  return {
    ...seed,
    oat,
    worker,
    source,
    path: `/api/v1/projects/${seed.project.externalRef}/background-workers/dev/${worker.version}`,
  };
}

// This harness uses real OSS authentication; restricted PAT roles require the enterprise plugin.
describe("background worker source authorization", () => {
  it.each(["PAT", "OAT", "API key"] as const)(
    "returns decompressed source to an authorized %s",
    async (credential) => {
      const token =
        credential === "PAT"
          ? fixture.pat.token
          : credential === "OAT"
            ? fixture.oat
            : fixture.environment.apiKey;
      const response = await server.webapp.fetch(fixture.path, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: fixture.worker.friendlyId,
        version: fixture.worker.version,
        files: [{ contents: fixture.source, filePath: "src/task.ts" }],
      });
    }
  );

  it("rejects missing credentials", async () => {
    const response = await server.webapp.fetch(fixture.path);

    expect(response.status).toBe(401);
  });

  it("does not expose source to a PAT from another organization", async () => {
    const other = await seedTestUserProject(server.prisma);
    const response = await server.webapp.fetch(fixture.path, {
      headers: { Authorization: `Bearer ${other.pat.token}` },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(fixture.source);
  });
});

async function plantWorker(version: string, ...sources: Array<string | Buffer>) {
  return server.prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${randomBytes(8).toString("hex")}`,
      engine: "V2",
      projectId: fixture.project.id,
      runtimeEnvironmentId: fixture.environment.id,
      version,
      contentHash: `hash-${version}`,
      metadata: {},
      files: {
        create: sources.map((source, i) => ({
          friendlyId: `file_${randomBytes(8).toString("hex")}`,
          projectId: fixture.project.id,
          filePath: `src/big-${i}.ts`,
          contentHash: `file-hash-${version}-${i}`,
          contents: Buffer.from(deflateSync(source).toString("base64")),
        })),
      },
    },
  });
}

describe("background worker source size limits", () => {
  const get = (version: string) =>
    server.webapp.fetch(
      `/api/v1/projects/${fixture.project.externalRef}/background-workers/dev/${version}`,
      { headers: { Authorization: `Bearer ${fixture.environment.apiKey}` } }
    );

  it("returns 413 for a stored file past the per-file limit", async () => {
    await plantWorker("20261117.1", Buffer.alloc(64 * MiB));

    const response = await get("20261117.1");

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "This worker's source files are too large to return.",
    });
  });

  it("returns 413 when the escaped response passes the per-worker limit", async () => {
    // 6 MiB of NUL bytes is within the per-file limit but 36 MiB once JSON-escaped.
    await plantWorker("20261117.2", Buffer.alloc(6 * MiB));

    const response = await get("20261117.2");

    expect(response.status).toBe(413);
  });

  it("refuses an oversized upload with the reason and writes nothing", async () => {
    const response = await server.webapp.fetch(
      `/api/v1/projects/${fixture.project.externalRef}/background-workers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixture.environment.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          localOnly: true,
          engine: "V2",
          metadata: {
            packageVersion: "4.6.0",
            contentHash: "oversized-upload",
            tasks: [{ id: "big", filePath: "src/big.ts", exportName: "big" }],
            sourceFiles: [
              {
                filePath: "src/big.ts",
                contentHash: "oversized-upload-file",
                contents: deflateSync(Buffer.alloc(64 * MiB)).toString("base64"),
                taskIds: ["big"],
              },
            ],
          },
        }),
      }
    );

    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toContain('"src/big.ts"');
    expect(
      await server.prisma.backgroundWorker.count({ where: { contentHash: "oversized-upload" } })
    ).toBe(0);
  });

  // Catches: the read slot being freed before the response is sent, so clients that stop reading
  // pile up response bodies in server memory.
  it("holds the read slot until a slow client takes its response", async () => {
    const chunk = "export const value = 1;".repeat(300_000); // ~7 MiB, too big for socket buffers
    await plantWorker("20261117.3", chunk, chunk, chunk);
    await plantWorker("20261117.4", "export const small = 1;");

    const { hostname, port } = new URL(server.webapp.baseUrl);
    const paused = connect({ host: hostname, port: Number(port) });
    paused.pause();
    paused.write(
      `GET /api/v1/projects/${fixture.project.externalRef}/background-workers/dev/20261117.3 HTTP/1.1\r\n` +
        `Host: ${hostname}\r\nAuthorization: Bearer ${fixture.environment.apiKey}\r\n\r\n`
    );

    try {
      // Give the paused read time to take the slot and start sending.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const small = get("20261117.4");
      const waited = await Promise.race([
        small.then(() => "finished"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 1_500)),
      ]);
      expect(waited).toBe("waiting");

      paused.destroy();
      const response = await small;
      expect(response.status).toBe(200);
    } finally {
      paused.destroy();
    }
  });
});
