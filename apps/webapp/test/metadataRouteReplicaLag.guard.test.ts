import { heteroPostgresTest } from "@internal/testcontainers";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { createHash } from "node:crypto";
import { expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

heteroPostgresTest(
  "metadata/tags enforce scoped writes and metadata reads the primary after a replica miss",
  async ({ prisma14, prisma17, uri14, uri17 }) => {
    const organization = await prisma14.organization.create({
      data: { title: "test", slug: "test" },
    });
    const project = await prisma14.project.create({
      data: { name: "test", slug: "test", organizationId: organization.id, externalRef: "test" },
    });
    const environment = await prisma14.runtimeEnvironment.create({
      data: {
        slug: "test",
        type: "DEVELOPMENT",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: "tr_dev_metadata",
        pkApiKey: "pk_dev_metadata",
        shortcode: "test",
      },
    });
    // Authentication is visible on both databases, but the newly created run
    // exists only on the writer, reproducing replica lag without mocking reads.
    await prisma17.organization.create({
      data: { id: organization.id, title: "test", slug: "test" },
    });
    await prisma17.project.create({
      data: {
        id: project.id,
        name: "test",
        slug: "test",
        organizationId: organization.id,
        externalRef: "test",
      },
    });
    await prisma17.runtimeEnvironment.create({
      data: {
        id: environment.id,
        slug: "test",
        type: "DEVELOPMENT",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: environment.apiKey,
        pkApiKey: environment.pkApiKey,
        shortcode: "test",
      },
    });
    const run = await prisma14.taskRun.create({
      data: {
        ...RunId.generate(),
        taskIdentifier: "my-task",
        payload: "{}",
        traceId: "1234",
        spanId: "1234",
        queue: "test",
        runtimeEnvironmentId: environment.id,
        projectId: project.id,
        organizationId: organization.id,
        environmentType: "DEVELOPMENT",
        engine: "V2",
        metadata: '{"phase":"one"}',
        metadataType: "application/json",
      },
    });

    process.env.DATABASE_URL = uri14;
    process.env.DIRECT_URL = uri14;
    process.env.CONTROL_PLANE_DATABASE_URL = uri14;
    process.env.DATABASE_READ_REPLICA_URL = uri17;
    process.env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL = uri17;
    process.env.TRIGGER_MOLLIFIER_ENABLED = "0";
    process.env.BATCH_METADATA_OPERATIONS_FLUSH_ENABLED = "0";

    // The route's singletons must be created after the container URLs are available.
    const { loader, action: updateMetadata } = await import("~/routes/api.v1.runs.$runId.metadata");
    const { action: addTags } = await import("~/routes/api.v1.runs.$runId.tags");
    const callLoader = (runId: string) =>
      loader({
        request: new Request(`https://example.com/api/v1/runs/${runId}/metadata`, {
          headers: { Authorization: `Bearer ${environment.apiKey}` },
        }),
        params: { runId },
        context: {},
      });
    const response = await callLoader(run.friendlyId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      metadata: run.metadata,
      metadataType: run.metadataType,
    });
    const missing = await callLoader(RunId.generate().friendlyId);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Run not found" });

    let keyCount = 0;
    const restrictedKey = async (scopes: string[]) => {
      const key = `tr_dev_sk_${String(++keyCount).padStart(24, "0")}`;
      const data = {
        id: `metadata_key_${keyCount}`,
        name: "Restricted metadata key",
        keyHash: createHash("sha256").update(key).digest("hex"),
        lastFour: key.slice(-4),
        runtimeEnvironmentId: environment.id,
        scopes,
      };
      await prisma14.apiKey.create({ data });
      await prisma17.apiKey.create({ data });
      return key;
    };
    const mutationArgs = (token: string, method: string, body: unknown) => ({
      request: new Request(`https://example.com/api/v1/runs/${run.friendlyId}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(JSON.stringify(body)).toString(),
        },
        body: JSON.stringify(body),
      }),
      params: { runId: run.friendlyId },
      context: {},
    });
    const publicToken = await generateJWT({
      secretKey: environment.apiKey,
      payload: { pub: true, sub: environment.id, scopes: ["admin"] },
      expirationTime: "15m",
    });
    expect(
      (await updateMetadata(mutationArgs(publicToken, "PUT", { metadata: { denied: true } })))
        .status
    ).toBe(401);
    expect((await addTags(mutationArgs(publicToken, "POST", { tags: ["denied"] }))).status).toBe(
      401
    );

    const reader = await restrictedKey([`read:runs:${run.friendlyId}`]);
    expect(
      (await updateMetadata(mutationArgs(reader, "PUT", { metadata: { denied: true } }))).status
    ).toBe(403);
    expect((await addTags(mutationArgs(reader, "POST", { tags: ["denied"] }))).status).toBe(403);
    const unchanged = await prisma14.taskRun.findFirst({ where: { id: run.id } });
    expect(unchanged?.metadata).toBe(run.metadata);
    expect(unchanged?.runTags).toEqual([]);

    const admin = await restrictedKey(["admin"]);
    expect(
      (await updateMetadata(mutationArgs(admin, "PUT", { metadata: { accepted: true } }))).status
    ).toBe(200);
    expect((await addTags(mutationArgs(admin, "POST", { tags: ["accepted"] }))).status).toBe(200);
    const updated = await prisma14.taskRun.findFirst({ where: { id: run.id } });
    expect(JSON.parse(updated!.metadata!)).toEqual({ accepted: true });
    expect(updated?.runTags).toEqual(["accepted"]);
  }
);
