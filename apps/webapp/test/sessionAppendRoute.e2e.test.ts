/**
 * Characterisation of the public session append route
 * (`POST /realtime/v1/sessions/:session/:io/append`): idempotency, guards,
 * best-effort ensure and ingress sanitising, over real HTTP against the real
 * webapp + Postgres + Redis + s2-lite.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@trigger.dev/database";
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

type SessionOverrides = Partial<
  Pick<
    Prisma.SessionUncheckedCreateInput,
    "closedAt" | "closedReason" | "expiresAt" | "triggerConfig"
  >
>;

async function setupSession(overrides: SessionOverrides = {}) {
  const { organization, project, environment, apiKey } = await seedTestEnvironment(server.prisma);
  const addressingKey = `sess-${randomBytes(6).toString("hex")}`;
  const session = await server.prisma.session.create({
    data: {
      friendlyId: `session_${randomBytes(8).toString("hex")}`,
      externalId: addressingKey,
      type: "chat.agent",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      environmentType: environment.type,
      organizationId: organization.id,
      taskIdentifier: "chat-agent",
      triggerConfig: { basePayload: {} },
      ...overrides,
    },
  });
  const token = await mintSessionToken({ apiKey, envId: environment.id, addressingKey });
  return { sessionId: session.id, addressingKey, token, apiKey };
}

async function append(opts: {
  addressingKey: string;
  token: string;
  body: string;
  io?: "in" | "out";
  partId?: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${server.webapp.baseUrl}/realtime/v1/sessions/${encodeURIComponent(opts.addressingKey)}/${
      opts.io ?? "in"
    }/append`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
        ...(opts.partId ? { "X-Part-Id": opts.partId } : {}),
      },
      body: opts.body,
    }
  );
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function readIn(addressingKey: string, apiKey: string) {
  const res = await fetch(
    `${server.webapp.baseUrl}/realtime/v1/sessions/${encodeURIComponent(addressingKey)}/in/records`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  expect(res.status).toBe(200);
  const { records } = (await res.json()) as {
    records: Array<{ data: string; id: string; seqNum: number }>;
  };
  return records;
}

const message = (text: string) => JSON.stringify({ kind: "message", payload: { text } });

describe("public session append route", () => {
  it("ensures a run, appends a record and returns its seq", async () => {
    const { sessionId, addressingKey, token, apiKey } = await setupSession();

    const res = await append({ addressingKey, token, body: message("hi"), partId: "p0" });

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(typeof res.json.seq).toBe("number");

    const records = await readIn(addressingKey, apiKey);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "p0", data: message("hi"), seqNum: res.json.seq });

    const row = await server.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.currentRunId).not.toBeNull();
  });

  describe("idempotency", () => {
    it("a duplicate X-Part-Id succeeds without a seq and appends once", async () => {
      const { addressingKey, token, apiKey } = await setupSession();

      const first = await append({ addressingKey, token, body: message("a"), partId: "dup" });
      const second = await append({ addressingKey, token, body: message("a"), partId: "dup" });

      expect(first.status).toBe(200);
      expect(typeof first.json.seq).toBe("number");
      expect(second.status).toBe(200);
      expect(second.json.ok).toBe(true);
      expect(second.json).not.toHaveProperty("seq");

      const records = await readIn(addressingKey, apiKey);
      expect(records.map((r) => r.id)).toEqual(["dup"]);
    });

    it("a rejected append releases the claim so a retry with the same id goes through", async () => {
      const { addressingKey, token, apiKey } = await setupSession();

      // Under the HTTP body cap, but every quote doubles when wrapped, so S2's record cap rejects it.
      const tooBigWhenWrapped = '"'.repeat(600 * 1024);
      const rejected = await append({ addressingKey, token, body: tooBigWhenWrapped, partId: "p" });
      expect(rejected.status).toBe(413);
      expect(rejected.json.ok).toBe(false);

      const retried = await append({ addressingKey, token, body: message("ok"), partId: "p" });
      expect(retried.status).toBe(200);
      expect(typeof retried.json.seq).toBe("number");

      const records = await readIn(addressingKey, apiKey);
      expect(records.map((r) => r.id)).toEqual(["p"]);
    });

    it("appends without X-Part-Id are never deduplicated", async () => {
      const { addressingKey, token, apiKey } = await setupSession();

      const first = await append({ addressingKey, token, body: message("same") });
      const second = await append({ addressingKey, token, body: message("same") });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.json.seq).not.toBe(second.json.seq);

      const records = await readIn(addressingKey, apiKey);
      expect(records).toHaveLength(2);
      expect(records[0]!.id).not.toBe(records[1]!.id);
    });
  });

  describe("guards", () => {
    it("rejects a closed session with 409 and appends nothing", async () => {
      const { addressingKey, token, apiKey } = await setupSession({
        closedAt: new Date(),
        closedReason: "done",
      });

      const res = await append({ addressingKey, token, body: message("late"), partId: "x" });

      expect(res.status).toBe(409);
      expect(res.json).toEqual({
        ok: false,
        error: "Cannot append to a closed session",
        code: "session_closed",
        closedReason: "done",
      });
      expect(await readIn(addressingKey, apiKey)).toEqual([]);
    });

    it("rejects an expired session with 400", async () => {
      const { addressingKey, token, apiKey } = await setupSession({
        expiresAt: new Date(Date.now() - 60_000),
      });

      const res = await append({ addressingKey, token, body: message("late") });

      expect(res.status).toBe(400);
      expect(res.json).toEqual({
        ok: false,
        error: "Cannot append to an expired session",
        code: "session_expired",
      });
      expect(await readIn(addressingKey, apiKey)).toEqual([]);
    });

    it("rejects an .out append with a session token", async () => {
      const { addressingKey, token } = await setupSession();

      const res = await append({ addressingKey, token, io: "out", body: message("forged") });

      expect(res.status).toBe(403);
      expect(res.json.ok).toBe(false);
    });
  });

  describe("ensure and sanitising", () => {
    it("still appends when ensuring a run fails", async () => {
      // No `basePayload`, so the trigger config fails to parse inside ensureRunForSession.
      const { sessionId, addressingKey, token, apiKey } = await setupSession({ triggerConfig: {} });

      const res = await append({ addressingKey, token, body: message("hi"), partId: "e" });

      expect(res.status).toBe(200);
      expect(typeof res.json.seq).toBe("number");
      expect((await readIn(addressingKey, apiKey)).map((r) => r.id)).toEqual(["e"]);

      const row = await server.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.currentRunId).toBeNull();
      expect(row.currentRunVersion).toBe(0);
    });

    it("ensures a continuation run before appending, so a rejected append still revives the session", async () => {
      const { sessionId, addressingKey, token } = await setupSession({
        triggerConfig: { basePayload: { message: "boot", trigger: "submit-message" } },
      });

      await append({ addressingKey, token, body: message("first"), partId: "a" });
      const { currentRunId: deadRunId } = await server.prisma.session.findUniqueOrThrow({
        where: { id: sessionId },
      });
      const deadRun = await server.prisma.taskRun.update({
        where: { id: deadRunId! },
        data: { status: "COMPLETED_SUCCESSFULLY" },
      });

      const tooBigWhenWrapped = '"'.repeat(600 * 1024);
      const rejected = await append({ addressingKey, token, body: tooBigWhenWrapped, partId: "b" });
      expect(rejected.status).toBe(413);

      const row = await server.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.currentRunId).not.toBeNull();
      expect(row.currentRunId).not.toBe(deadRunId);

      const revived = await server.prisma.taskRun.findUniqueOrThrow({
        where: { id: row.currentRunId! },
      });
      const payload = JSON.parse(revived.payload);
      expect(payload).toMatchObject({ continuation: true, previousRunId: deadRun.friendlyId });
      expect(payload).not.toHaveProperty("message");
      expect(payload).not.toHaveProperty("trigger");
    });

    it("strips ingress-only fields from an .in record", async () => {
      const { addressingKey, token, apiKey } = await setupSession();
      const forged = JSON.stringify({
        kind: "message",
        payload: { text: "hi", actionSource: "webhook", channelEvent: { connectorId: "slack" } },
      });

      const res = await append({ addressingKey, token, body: forged, partId: "s" });

      expect(res.status).toBe(200);
      const [record] = await readIn(addressingKey, apiKey);
      expect(JSON.parse(record!.data)).toEqual({ kind: "message", payload: { text: "hi" } });
    });
  });
});
