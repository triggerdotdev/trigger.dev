// vitest globalSetup — runs once for the whole *.e2e.full.test.ts suite.
// Boots one Postgres + Redis + webapp; tests connect to it via the
// `baseUrl` / `databaseUrl` values provided to test workers below.
//
// Each test file recreates its own PrismaClient connected to the shared DB
// (PrismaClient instances aren't serialisable across worker boundaries).

import type { TestProject } from "vitest/node";
import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";

let server: TestServer | undefined;

export default async function setup(project: TestProject) {
  server = await startTestServer();
  project.provide("baseUrl", server.webapp.baseUrl);
  project.provide("databaseUrl", server.databaseUrl);

  return async () => {
    await server?.stop().catch(() => {});
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
    databaseUrl: string;
  }
}
