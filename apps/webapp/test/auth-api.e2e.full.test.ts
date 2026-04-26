// Comprehensive API auth tests — uses the shared TestServer started by
// vitest.e2e.full.config.ts's globalSetup. Family subtasks under TRI-8731
// add nested describe blocks here:
//
//   describe("API", () => {
//     describe("Trigger task", () => { ... })   // TRI-8733
//     describe("Runs — resource routes", () => { ... }) // TRI-8734
//     ...
//   })
//
// See test/helpers/sharedTestServer.ts for `getTestServer()`.

import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";

describe("API", () => {
  // Placeholder until family subtasks add their describes (TRI-8733+).
  // Verifies the shared container is reachable from this worker.
  it("shared webapp container responds to /healthcheck", async () => {
    const server = getTestServer();
    const res = await server.webapp.fetch("/healthcheck");
    expect(res.ok).toBe(true);
  });
});
