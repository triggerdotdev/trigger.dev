// vitest globalSetup — runs once for the whole *.e2e.full.test.ts suite.
// Boots one Postgres + Redis + webapp; tests connect to it via the
// `baseUrl` / `databaseUrl` values provided to test workers below.
//
// Each test file recreates its own PrismaClient connected to the shared DB
// (PrismaClient instances aren't serialisable across worker boundaries).

import type { TestProject } from "vitest/node";
import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";

let server: TestServer | undefined;

const E2E_BILLING_SERVICE_SECRET = "test-billing-service-secret-for-e2e-tests";

export default async function setup(project: TestProject) {
  // A billing service secret so tests can prove that credential is refused where it should be.
  // Dummy GitHub OAuth credentials register the strategy so its callback route can be tested.
  server = await startTestServer({
    extraEnv: {
      BILLING_SERVICE_SECRET: E2E_BILLING_SERVICE_SECRET,
      AUTH_GITHUB_CLIENT_ID: "e2e-github-client-id",
      AUTH_GITHUB_CLIENT_SECRET: "e2e-github-client-secret",
      AUTH_GOOGLE_CLIENT_ID: "e2e-google-client-id",
      AUTH_GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
    },
  });
  project.provide("baseUrl", server.webapp.baseUrl);
  project.provide("billingServiceSecret", E2E_BILLING_SERVICE_SECRET);
  project.provide("databaseUrl", server.databaseUrl);

  return async () => {
    await server?.stop().catch(() => {});
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
    databaseUrl: string;
    billingServiceSecret: string;
  }
}
