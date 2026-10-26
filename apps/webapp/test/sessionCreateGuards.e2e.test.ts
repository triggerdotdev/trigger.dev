/**
 * Session create and stream addressing guards over real HTTP against the real
 * webapp + Postgres + Redis + s2-lite: externalIds that would name another
 * session's channel stream, and ingress-only fields in a client base payload.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionStreamTestServer } from "@internal/testcontainers/webapp";
import { startSessionStreamTestServer } from "@internal/testcontainers/webapp";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { mintSessionToken } from "./helpers/sessionStream";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let server: SessionStreamTestServer;

beforeAll(async () => {
  server = await startSessionStreamTestServer();
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

const suffix = () => randomBytes(6).toString("hex");

async function createSession(apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${server.webapp.baseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "chat.agent",
      taskIdentifier: "e2e-guard-agent",
      triggerConfig: { basePayload: {} },
      ...body,
    }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

describe("session externalIds cannot name another session's channel stream", () => {
  it("rejects a /channels segment at create and accepts other slashes", async () => {
    const { environment, apiKey } = await seedTestEnvironment(server.prisma);
    const victim = `victim-${suffix()}`;

    for (const externalId of [`${victim}/channels/tools`, `${victim}/channels`]) {
      const res = await createSession(apiKey, { externalId });
      expect(res.status).toBe(422);
      expect(res.json.error).toContain('"/channels" path segment');
    }
    expect(
      await server.prisma.session.count({ where: { runtimeEnvironmentId: environment.id } })
    ).toBe(0);

    for (const externalId of [`org/${suffix()}/chat-9`, `channels/${suffix()}`]) {
      const res = await createSession(apiKey, { externalId });
      expect(res.status).toBe(201);
      expect(res.json.externalId).toBe(externalId);
    }
  });

  it("refuses a token scoped to such a key on the stream routes", async () => {
    const { organization, project, environment, apiKey } = await seedTestEnvironment(server.prisma);
    const aliasKey = `victim-${suffix()}/channels/tools`;
    const token = await mintSessionToken({
      apiKey,
      envId: environment.id,
      addressingKey: aliasKey,
    });
    const base = `${server.webapp.baseUrl}/realtime/v1/sessions/${encodeURIComponent(aliasKey)}`;

    const noRowSubscribe = await fetch(`${base}/out`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(noRowSubscribe.status).toBe(403);

    await server.prisma.session.create({
      data: {
        friendlyId: `session_${suffix()}`,
        externalId: aliasKey,
        type: "chat.agent",
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        environmentType: environment.type,
        organizationId: organization.id,
        taskIdentifier: "e2e-guard-agent",
        triggerConfig: { basePayload: {} },
      },
    });

    const append = await fetch(`${base}/in/append`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "message", payload: { trigger: "submit-message" } }),
    });
    expect(append.status).toBe(403);
  });
});

describe("session create drops ingress-only fields from the base payload", () => {
  it("stores and boots the run without channelEvent or a webhook actionSource", async () => {
    const { apiKey } = await seedTestEnvironment(server.prisma);

    const res = await createSession(apiKey, {
      externalId: `chat-${suffix()}`,
      triggerConfig: {
        basePayload: {
          messages: [],
          trigger: "action",
          actionSource: "webhook",
          action: { type: "refund" },
          channelEvent: { connectorId: "slack", event: { team_id: "T1" } },
          metadata: { userId: "u1" },
        },
      },
    });
    expect(res.status).toBe(201);

    const session = await server.prisma.session.findFirstOrThrow({
      where: { friendlyId: res.json.id },
      select: { triggerConfig: true },
    });
    const stored = (session.triggerConfig as { basePayload: Record<string, unknown> }).basePayload;
    expect(stored).toEqual({
      messages: [],
      trigger: "action",
      action: { type: "refund" },
      metadata: { userId: "u1" },
    });

    const run = await server.prisma.taskRun.findFirstOrThrow({
      where: { friendlyId: res.json.runId },
      select: { payload: true },
    });
    const payload = JSON.parse(run.payload) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("channelEvent");
    expect(payload).not.toHaveProperty("actionSource");
    expect(payload).toMatchObject({ trigger: "action", action: { type: "refund" } });
  });
});
