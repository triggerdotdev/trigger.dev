import { createStandalonePostgresContainer } from "@internal/testcontainers";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Database from "~/db.server";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

const INHERITED_FLAGS = ["allowJWT", "allowPreviewParent", "allowRunToken", "allowPublicKey"];

let database: typeof Database;
let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("DIRECT_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("MAGIC_LINK_SECRET", "auth-flags-test-magic-link");
  vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-for-e2e!!!!!");
  vi.stubEnv("CLICKHOUSE_URL", "http://localhost:19123");
  vi.stubEnv("DEPLOY_REGISTRY_HOST", "registry.example.com");
  vi.stubEnv("V4_DEPLOY_REGISTRY_HOST", "registry.example.com");
  vi.stubEnv("RBAC_FORCE_FALLBACK", "1");
  database = await import("~/db.server");
}, 120_000);

afterEach(() => {
  for (const flag of INHERITED_FLAGS) {
    delete (Object.prototype as Record<string, unknown>)[flag];
  }
});

afterAll(async () => {
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

// Non-enumerable so database lookups are unaffected and only the auth flags are under test.
function setInheritedFlags() {
  for (const flag of INHERITED_FLAGS) {
    Object.defineProperty(Object.prototype, flag, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}

async function publicJwtFor(environment: { id: string; apiKey: string }) {
  return generateJWT({
    secretKey: environment.apiKey,
    payload: { sub: environment.id, pub: true, scopes: ["read:runs"] },
    expirationTime: "1h",
  });
}

describe("auth flags come only from the caller", () => {
  // Catches: a loader route honouring an auth flag it never set.
  it("keeps a loader route without allowJWT closed to public JWTs", async () => {
    const { environment } = await seedTestEnvironment(database.prisma);
    const { createLoaderApiRoute } = await import("~/services/routeBuilders/apiBuilder.server");
    const handler = async () => new Response("ok");
    const options = {
      findResource: async () => ({ type: "runs" as const }),
      authorization: { action: "read", resource: (resource: { type: "runs" }) => resource },
    };
    const closed = createLoaderApiRoute(options, handler);
    const open = createLoaderApiRoute({ ...options, allowJWT: true }, handler);
    const token = await publicJwtFor(environment);
    const call = (route: typeof closed) =>
      route({
        request: new Request("https://api.example.com/runs", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        params: {},
        context: {},
      });

    // The token itself is valid: a route that opts in accepts it.
    expect((await call(open)).status).toBe(200);

    setInheritedFlags();

    expect((await call(closed)).status).toBe(401);
  });

  // Catches: the bearer resolver honouring an auth flag the caller never set.
  it("does not let the bearer resolver accept a public JWT the caller did not allow", async () => {
    const { environment } = await seedTestEnvironment(database.prisma);
    const { rbac } = await import("~/services/rbac.server");
    const token = await publicJwtFor(environment);
    const request = new Request("https://api.example.com/runs", {
      headers: { Authorization: `Bearer ${token}` },
    });

    setInheritedFlags();

    expect((await rbac.authenticateBearer(request, {})).ok).toBe(false);
  });

  // Catches: scoped API key auth honouring an auth flag the caller never set.
  it("does not let authenticateApiKeyWithScope pass inherited flags to the resolver", async () => {
    const { authenticateApiKeyWithScope } = await import("~/services/apiAuth.server");
    const authorizeBearer = vi.fn().mockResolvedValue({
      ok: true,
      environment: { id: "env_123" },
      ability: { can: () => true, canSuper: () => true },
      subject: { type: "runToken" },
    });
    const request = new Request("https://api.example.com/schedules", {
      headers: { Authorization: "Bearer tr_test_key" },
    });

    setInheritedFlags();

    const result = await authenticateApiKeyWithScope(
      request,
      { action: "read", resource: { type: "schedules" } },
      authorizeBearer,
      vi.fn().mockResolvedValue(false)
    );

    expect(authorizeBearer).toHaveBeenCalledWith(
      request,
      { action: "read", resource: { type: "schedules" } },
      { allowJWT: false, allowPreviewParent: false }
    );
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Run tokens are not accepted for this endpoint",
    });
  });
});
