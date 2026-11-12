// Run, batch and session tokens minted for a request authenticated by an env JWT exchanged from a
// PAT name the same (sealed) source PAT, so they end with it. The unit suite checks that a token
// naming a PAT dies with it; this one checks that each real minting route stamps the claim, so a
// route that stops passing the request's actor fails here.

//
// Requires a pre-built webapp: pnpm run build --filter webapp

import type { PrismaClient } from "@trigger.dev/database";
import type { TestServer } from "@internal/testcontainers/webapp";
import { startTestServer } from "@internal/testcontainers/webapp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTestUserProject } from "./helpers/seedTestUserProject";

vi.setConfig({ testTimeout: 180_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

const TASK_IDENTIFIER = "pat-derived-child-tokens";

function payloadOf(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

async function seedTask(prisma: PrismaClient, projectId: string, runtimeEnvironmentId: string) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${runtimeEnvironmentId}`,
      contentHash: `hash_${runtimeEnvironmentId}`,
      version: "20261112.1",
      // A v4 worker: v3 (engine V1) triggers are rejected.
      engine: "V2",
      metadata: {},
      projectId,
      runtimeEnvironmentId,
    },
  });
  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${runtimeEnvironmentId}`,
      slug: TASK_IDENTIFIER,
      filePath: "src/trigger/pat-derived-child-tokens.ts",
      workerId: worker.id,
      projectId,
      runtimeEnvironmentId,
    },
  });
}

/** A dev env JWT exchanged from a fresh PAT, through the real exchange route. */
async function patDerivedJwt() {
  const { project, environment, pat } = await seedTestUserProject(server.prisma);
  await seedTask(server.prisma, project.id, environment.id);

  const response = await server.webapp.fetch(`/api/v1/projects/${project.externalRef}/dev/jwt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ claims: { scopes: ["admin"] } }),
  });
  expect(response.status).toBe(200);
  const { token } = (await response.json()) as { token: string };
  return token;
}

function post(path: string, jwt: string, body: unknown) {
  return server.webapp.fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type MintedToken = { token: string | null; readPath: string };

const MINTING_ROUTES: Array<[name: string, mint: (jwt: string) => Promise<MintedToken>]> = [
  [
    "POST /api/v1/tasks/:taskId/trigger",
    async (jwt) => {
      const response = await post(`/api/v1/tasks/${TASK_IDENTIFIER}/trigger`, jwt, {
        payload: {},
      });
      expect(response.status).toBe(200);
      const { id } = (await response.json()) as { id: string };
      return { token: response.headers.get("x-trigger-jwt"), readPath: `/api/v3/runs/${id}` };
    },
  ],
  [
    "POST /api/v1/tasks/batch",
    async (jwt) => {
      const response = await post("/api/v1/tasks/batch", jwt, {
        items: [{ task: TASK_IDENTIFIER, payload: {} }],
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as { batchId?: string; id?: string };
      return {
        token: response.headers.get("x-trigger-jwt"),
        readPath: `/api/v1/batches/${body.batchId ?? body.id}`,
      };
    },
  ],
  [
    "POST /api/v2/tasks/batch",
    async (jwt) => {
      const response = await post("/api/v2/tasks/batch", jwt, {
        items: [{ task: TASK_IDENTIFIER, payload: {} }],
      });
      expect(response.status).toBe(202);
      const { id } = (await response.json()) as { id: string };
      return { token: response.headers.get("x-trigger-jwt"), readPath: `/api/v1/batches/${id}` };
    },
  ],
  [
    "POST /api/v3/batches",
    async (jwt) => {
      const response = await post("/api/v3/batches", jwt, { runCount: 1 });
      expect(response.status).toBe(202);
      const { id } = (await response.json()) as { id: string };
      return { token: response.headers.get("x-trigger-jwt"), readPath: `/api/v1/batches/${id}` };
    },
  ],
  [
    "POST /api/v1/sessions",
    async (jwt) => {
      const externalId = `pat-derived-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await post("/api/v1/sessions", jwt, {
        type: "pat-derived-child-tokens",
        externalId,
        taskIdentifier: TASK_IDENTIFIER,
        triggerConfig: { basePayload: {} },
      });
      expect(response.status).toBe(201);
      const { publicAccessToken } = (await response.json()) as { publicAccessToken: string };
      return { token: publicAccessToken, readPath: `/api/v1/sessions/${externalId}` };
    },
  ],
];

describe("tokens minted for a PAT-derived env JWT", () => {
  for (const [name, mint] of MINTING_ROUTES) {
    /** Catches: the route not passing the request's actor, so its token outlives the PAT. */
    it(`${name}: names the same sealed source PAT, and nothing else from act`, async () => {
      const jwt = await patDerivedJwt();
      const sourcePat = payloadOf(jwt).act?.pat;
      expect(sourcePat).toMatch(/^pat_v1_/);

      const { token, readPath } = await mint(jwt);

      expect(token).toBeTruthy();
      expect(payloadOf(token!).act).toEqual({ pat: sourcePat });
      const read = await server.webapp.fetch(readPath, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(read.status).toBe(200);
    });
  }
});
