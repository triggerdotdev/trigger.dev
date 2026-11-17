import { buildJwtAbility } from "@trigger.dev/rbac";
import { json } from "@remix-run/server-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as webappRouteMocks from "./helpers/webappRouteMocks";

const mocks = vi.hoisted(() => ({
  authenticateUserActor: vi.fn(),
  authenticatePat: vi.fn(),
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateUserActor: mocks.authenticateUserActor,
    authenticatePat: mocks.authenticatePat,
  },
}));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/services/personalAccessToken.server", () => ({
  ...webappRouteMocks.personalAccessTokenMock(),
  personalAccessTokenAuthFailureBody: (result: { error: string }) => ({ error: result.error }),
}));
vi.mock("~/services/authTelemetry.server", () => webappRouteMocks.authTelemetryMock());
vi.mock("~/services/logger.server", () => webappRouteMocks.loggerMock());
vi.mock("~/services/tenantContext.server", () => webappRouteMocks.tenantContextMock());
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () =>
  webappRouteMocks.workerGroupTokenServiceMock()
);
vi.mock("~/v3/services/common.server", () => webappRouteMocks.serviceValidationErrorMock());
vi.mock("@internal/run-engine", () => webappRouteMocks.engineServiceValidationErrorMock());

import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const handler = vi.fn(async ({ body }: { body: unknown }) => json({ received: body }));

function route(options: { maxContentLength?: number } = {}) {
  return createActionPATApiRoute(
    {
      method: "POST",
      body: z.object({ name: z.string() }),
      ...options,
    },
    handler as any
  );
}

/** A request whose body records whether anything pulled from it. */
function trackedRequest(body: string, headers: Record<string, string> = {}) {
  const read = { started: false };
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read.started = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    // Pull only when something reads, not to pre-fill the queue.
    { highWaterMark: 0 }
  );
  const request = new Request("https://api.trigger.dev/api/v1/orgs", {
    method: "POST",
    headers: { Authorization: "Bearer tr_pat_test", ...headers },
    body: stream,
    // @ts-expect-error duplex is required by undici for stream bodies
    duplex: "half",
  });
  return { request, read };
}

async function call(action: ReturnType<typeof route>, request: Request) {
  const response = await action({ request, params: {}, context: {} } as any);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticatePat.mockResolvedValue({
    ok: true,
    userId: "usr_1",
    tokenId: "pat_1",
    lastAccessedAt: new Date(),
    ability: buildJwtAbility(["admin"]),
  });
});

describe("PAT action route builder", () => {
  it("parses the body for an accepted token", async () => {
    // Catches: an accepted token no longer reaching the handler with its parsed body.
    const { request } = trackedRequest(JSON.stringify({ name: "acme" }));

    const result = await call(route(), request);

    expect(result).toEqual({ status: 200, body: { received: { name: "acme" } } });
  });

  it("returns the auth failure without reading the body", async () => {
    // Catches: the request body being read before the token is checked.
    mocks.authenticatePat.mockResolvedValue({ ok: false, status: 401, error: "Invalid token" });
    const { request, read } = trackedRequest(JSON.stringify({ name: "acme" }));

    const result = await call(route(), request);

    expect(result.status).toBe(401);
    expect(read.started).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports the auth failure before body validation errors", async () => {
    // Catches: a body error answering in place of the auth failure.
    mocks.authenticatePat.mockResolvedValue({ ok: false, status: 401, error: "Invalid token" });
    const { request } = trackedRequest("not json");

    const result = await call(route(), request);

    expect(result.status).toBe(401);
  });

  it("rejects a body over maxContentLength with 413", async () => {
    // Catches: maxContentLength being ignored by PAT action routes.
    const body = JSON.stringify({ name: "a".repeat(100) });
    const { request, read } = trackedRequest(body, { "content-length": String(body.length) });

    const result = await call(route({ maxContentLength: 50 }), request);

    expect(result.status).toBe(413);
    expect(read.started).toBe(false);
  });

  it("accepts a body within maxContentLength", async () => {
    // Catches: maxContentLength rejecting a body under the limit.
    const body = JSON.stringify({ name: "acme" });
    const { request } = trackedRequest(body, { "content-length": String(body.length) });

    const result = await call(route({ maxContentLength: 1024 }), request);

    expect(result.status).toBe(200);
  });
});
