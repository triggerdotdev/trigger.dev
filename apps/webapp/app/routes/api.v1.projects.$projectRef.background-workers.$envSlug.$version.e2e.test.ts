import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { seedTestUserProject } from "../../test/helpers/seedTestUserProject";

let server: TestServer;
let fixture: Awaited<ReturnType<typeof seedWorkerSource>>;

beforeAll(async () => {
  server = await startTestServer();
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
