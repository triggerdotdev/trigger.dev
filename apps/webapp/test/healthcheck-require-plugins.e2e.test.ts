/**
 * E2E verification that REQUIRE_PLUGINS=1 fails the rollout via /healthcheck.
 *
 * The unit tests in @trigger.dev/rbac cover the loader throw. This file
 * closes the loop end-to-end: spawn a real webapp, hit /healthcheck via
 * HTTP, and verify the route's catch turns the throw into a 500 — the
 * status the ECS/k8s readiness probe rolls back on.
 *
 * Each case spawns its own webapp + Postgres + Redis container (~30s) so
 * env can differ per case. Slow but isolated, matching api-auth.e2e.test.ts.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestServer } from "@internal/testcontainers/webapp";
import { startTestServer } from "@internal/testcontainers/webapp";

vi.setConfig({ testTimeout: 180_000 });

describe("/healthcheck with REQUIRE_PLUGINS", () => {
  describe("REQUIRE_PLUGINS=1 + plugin missing", () => {
    let server: TestServer;

    beforeAll(async () => {
      // requirePlugins: true implies forceRbacFallback: false, so the
      // loader actually tries to dynamic-import the plugin. The plugin
      // is not installed in this OSS repo, so the import fails and the
      // loader throws (instead of falling back) because REQUIRE_PLUGINS=1.
      // The throw surfaces on the first .isUsingPlugin() call from the
      // /healthcheck route, which catches it and returns 500.
      server = await startTestServer({ requirePlugins: true });
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
    }, 120_000);

    it("returns 500 so the readiness probe fails and the rollout is rolled back", async () => {
      const res = await server.webapp.fetch("/healthcheck");
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("ERROR");
    });
  });

  describe("REQUIRE_PLUGINS unset + plugin missing", () => {
    let server: TestServer;

    beforeAll(async () => {
      // Default: forceRbacFallback=true so the loader short-circuits to
      // the fallback without trying to import. /healthcheck succeeds.
      server = await startTestServer();
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
    }, 120_000);

    it("returns 200 (baseline — unchanged self-hoster behaviour)", async () => {
      const res = await server.webapp.fetch("/healthcheck");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
    });
  });
});
