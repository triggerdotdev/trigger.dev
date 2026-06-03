// Per-worker access to the shared TestServer started by globalSetup. Each
// test file imports `getTestServer()` once at module top-level; the returned
// value is a singleton within that worker process.
//
// `webapp.fetch(path)` prepends the shared baseUrl. The PrismaClient is
// constructed lazily and disconnected on test-suite end via afterAll in the
// importing file (or left to the worker shutting down).

import { PrismaClient } from "@trigger.dev/database";
import { afterAll, inject } from "vitest";

interface SharedWebapp {
  baseUrl: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

interface SharedTestServer {
  webapp: SharedWebapp;
  prisma: PrismaClient;
}

let cached: SharedTestServer | undefined;

export function getTestServer(): SharedTestServer {
  if (cached) return cached;

  const baseUrl = inject("baseUrl");
  const databaseUrl = inject("databaseUrl");

  if (!baseUrl || !databaseUrl) {
    throw new Error(
      "globalSetup didn't provide baseUrl/databaseUrl — run via vitest.e2e.full.config.ts"
    );
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  cached = {
    webapp: {
      baseUrl,
      fetch: (path, init) => fetch(`${baseUrl}${path}`, init),
    },
    prisma,
  };

  // Disconnect the PrismaClient when the worker is done. globalSetup's
  // teardown stops the container; this just releases the per-worker pool.
  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  return cached;
}
