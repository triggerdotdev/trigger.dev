import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildJwtAbility } from "@trigger.dev/rbac";

const jwtMocks = vi.hoisted(() => ({
  validatePublicJwtKey: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("@internal/tracing", () => ({
  getMeter: () => ({
    createCounter: () => ({ add: vi.fn() }),
    createHistogram: () => ({ record: vi.fn() }),
    createObservableGauge: () => ({ addCallback: vi.fn() }),
  }),
}));
vi.mock("~/services/rbac.server", () => ({ rbac: { authenticateBearer: vi.fn() } }));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/models/project.server", () => ({ findProjectByRef: vi.fn() }));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  authIncludeBase: {},
  authIncludeWithParent: {},
  findEnvironmentByApiKey: vi.fn(),
  findEnvironmentByApiKeyWithResolution: vi.fn(),
  findEnvironmentByPublicApiKey: vi.fn(),
  toAuthenticated: vi.fn(),
}));
vi.mock("~/services/personalAccessToken.server", () => ({
  authenticateApiRequestWithPersonalAccessToken: vi.fn(),
  isPersonalAccessToken: () => false,
}));
vi.mock("~/services/organizationAccessToken.server", () => ({
  authenticateApiRequestWithOrganizationAccessToken: vi.fn(),
  isOrganizationAccessToken: () => false,
}));
vi.mock("~/services/realtime/jwtAuth.server", () => ({
  isPublicJWT: (token: string) => token.startsWith("jwt_"),
  validatePublicJwtKey: jwtMocks.validatePublicJwtKey,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { authenticateApiKey } from "~/services/apiAuth.server";

const environment = { id: "env_1", apiKey: "tr_prod_abc" };

function claims(extra: Record<string, unknown> = {}) {
  return { sub: environment.id, pub: true, scopes: ["read:runs"], ...extra };
}

async function authenticate(jwtClaims: Record<string, unknown>) {
  jwtMocks.validatePublicJwtKey.mockResolvedValue({
    ok: true,
    environment,
    claims: jwtClaims,
  });
  const result = await authenticateApiKey("jwt_token", { allowJWT: true });
  if (!result) throw new Error("expected authentication to succeed");
  return result;
}

describe("PUBLIC_JWT authentication — actor claim", () => {
  beforeEach(() => {
    jwtMocks.validatePublicJwtKey.mockReset();
  });

  it("surfaces actor when the JWT carries act", async () => {
    const result = await authenticate(
      claims({ act: { sub: "usr_42", client: "dashboard-agent" } })
    );

    expect(result.actor).toEqual({ sub: "usr_42", client: "dashboard-agent" });
  });

  it("accepts act without a client", async () => {
    const result = await authenticate(claims({ act: { sub: "usr_42" } }));

    expect(result.actor).toEqual({ sub: "usr_42" });
  });

  it("leaves actor undefined when the JWT has no act", async () => {
    const result = await authenticate(claims());

    expect(result.actor).toBeUndefined();
  });

  it("ignores a malformed act rather than failing the request", async () => {
    const result = await authenticate(claims({ act: { client: "dashboard-agent" } }));

    expect(result.ok).toBe(true);
    expect(result.actor).toBeUndefined();
  });

  it("does not let act widen authorization", async () => {
    // The act claim is identity data: authorization comes from sub + scopes only.
    const forged = claims({
      act: { sub: "usr_42", client: "dashboard-agent", scopes: ["admin"] },
    });
    const result = await authenticate(forged);

    expect(result.environment.id).toBe(environment.id);
    expect(result.actor).toEqual({ sub: "usr_42", client: "dashboard-agent" });

    const ability = buildJwtAbility(forged.scopes);
    expect(ability.rules).toEqual(buildJwtAbility(["read:runs"]).rules);
    expect(ability.can("read", { type: "runs" })).toBe(true);
    expect(ability.can("write", { type: "runs" })).toBe(false);
  });
});
