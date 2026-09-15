import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import type { AnyZodSchema } from "../../types/schemas.js";
import { SupervisorHttpClient } from "./http.js";
import { WorkerApiRunLatestSnapshotResponseBody } from "./schemas.js";

const createdAt = "2026-01-01T00:00:00.000Z";
const execution = {
  version: "1",
  snapshot: {
    id: "snapshot_1",
    friendlyId: "snap_1",
    executionStatus: "EXECUTING",
    description: "Run is executing",
    createdAt,
  },
  run: { id: "run_1", friendlyId: "run_1", status: "EXECUTING" },
  completedWaitpoints: [],
};

const compiledSchemas = new Map<AnyZodSchema, AnyZodSchema>([
  [
    WorkerApiRunLatestSnapshotResponseBody,
    z.compile(WorkerApiRunLatestSnapshotResponseBody, { strict: true }),
  ],
]);

function resolveCompiledSchema<T extends AnyZodSchema>(schema: T): T {
  return (compiledSchemas.get(schema) as T | undefined) ?? schema;
}

describe("supervisor response schema resolution", () => {
  let server: Server;
  let apiUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ execution: request.url?.includes("/invalid/") ? {} : execution })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([false, true])("parses responses with schema resolution enabled=%s", async (enabled) => {
    const resolved: AnyZodSchema[] = [];
    const client = new SupervisorHttpClient({
      apiUrl,
      workerToken: "token",
      instanceName: "test",
      resolveResponseSchema: enabled
        ? (schema) => {
            resolved.push(schema);
            return resolveCompiledSchema(schema);
          }
        : undefined,
    });

    const result = await client.getLatestSnapshot("run_1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.snapshot.createdAt).toEqual(new Date(createdAt));
      expect(result.data.execution.run.id).toBe("run_1");
    }
    expect(resolved).toEqual(enabled ? [WorkerApiRunLatestSnapshotResponseBody] : []);
  });

  it("returns a validation failure for malformed responses with compiled parsing", async () => {
    const client = new SupervisorHttpClient({
      apiUrl,
      workerToken: "token",
      instanceName: "test",
      resolveResponseSchema: resolveCompiledSchema,
    });

    const result = await client.getLatestSnapshot("invalid");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(200);
    }
  });
});
