import { buildJwtAbility } from "@trigger.dev/plugins";
import { describe, expect, it, vi } from "vitest";
import { runTokenScopes } from "~/services/oidc/runTokenClaims";
import { checkAuth } from "~/services/routeBuilders/apiBuilder.server";

// Capture each signal route's config and handler instead of building the real route.
const H = vi.hoisted(() => ({ routes: [] as Array<{ config: any; handler: any }> }));

vi.mock("~/services/routeBuilders/apiBuilder.server", async (importOriginal) => {
  const actual = await importOriginal<object>();
  const capture = (config: unknown, handler: unknown) => {
    H.routes.push({ config, handler });
    return { action: vi.fn(), loader: vi.fn() };
  };
  return { ...actual, createActionApiRoute: capture, createLoaderApiRoute: capture };
});

const captured = new Map<string, { config: any; handler: any }>();

async function route(path: string) {
  if (!captured.has(path)) {
    const before = H.routes.length;
    await import(/* @vite-ignore */ path);
    const entry = H.routes[before];
    if (!entry) throw new Error(`${path} not captured`);
    captured.set(path, entry);
  }
  return captured.get(path)!;
}

function allows(scopes: string[], authorization: { action: string; resource: () => any }) {
  return checkAuth(buildJwtAbility(scopes), authorization.action, authorization.resource());
}

const ROUTES = [
  "~/routes/api.v1.signals",
  "~/routes/api.v1.signals.clear",
  "~/routes/api.v1.signals.latest",
  "~/routes/realtime.v1.signals",
];

describe("signal route authorization", () => {
  // Catches: the signal routes declaring no authorization, so the route builder refused every run
  // token and restricted key with 403 and tasks couldn't send, clear or hear signals.
  it.each(ROUTES)("%s lets a run's own token and a key with signals access in", async (path) => {
    const { config } = await route(path);
    expect(config.authorization).toBeDefined();
    expect(allows(runTokenScopes(), config.authorization)).toBe(true);
    expect(allows(["read:all", "write:all"], config.authorization)).toBe(true);
    expect(allows([`${config.authorization.action}:signals`], config.authorization)).toBe(true);
    expect(allows(["read:runs", "write:runs"], config.authorization)).toBe(false);
  });

  // Catches: a public JWT with broad scopes passing the new authorization and reaching signals.
  it.each(ROUTES)("%s still refuses a public JWT", async (path) => {
    const { handler } = await route(path);
    const response: Response = await handler({
      request: new Request("http://localhost/signals", { method: "POST" }),
      body: { name: "a" },
      searchParams: { name: "a" },
      authentication: { type: "PUBLIC_JWT", environment: { id: "env_1" } },
    });
    expect(response.status).toBe(403);
  });
});
