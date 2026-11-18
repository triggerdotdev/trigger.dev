import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ SECRET_PROXY_RESOLVER_ENABLED: false }));
const resolve = vi.hoisted(() => vi.fn(async () => new Response(null, { status: 401 })));

vi.mock("~/env.server", () => ({ env }));
vi.mock("~/services/secretProxy/instance.server", () => ({ secretProxy: () => ({}) }));
vi.mock("~/services/secretProxy/resolveAction.server", () => ({
  resolveSecretProxyRequest: resolve,
}));

import { action, loader } from "~/routes/engine.v1.secret-proxy.resolve";

const request = (path = "/engine/v1/secret-proxy/resolve") =>
  new Request(`https://platform.example.com${path}`, { method: "POST" });

describe("secret proxy resolve route", () => {
  beforeEach(() => resolve.mockClear());

  it("does not exist on services without the resolver enabled", async () => {
    env.SECRET_PROXY_RESOLVER_ENABLED = false;
    expect((await action({ request: request() } as never)).status).toBe(404);
    expect((await loader({ request: request() } as never)).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("answers only the exact path on the resolver service", async () => {
    env.SECRET_PROXY_RESOLVER_ENABLED = true;
    for (const path of [
      "/engine/v1/secret%2Dproxy/resolve",
      "/%65ngine/v1/secret-proxy/resolve",
      "/engine/V1/secret-proxy/resolve",
    ]) {
      expect((await action({ request: request(path) } as never)).status).toBe(404);
    }
    expect(resolve).not.toHaveBeenCalled();
    await action({ request: request() } as never);
    expect(resolve).toHaveBeenCalledOnce();
  });
});
