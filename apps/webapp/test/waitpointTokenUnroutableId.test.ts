// `resolveShard` is pure id-shape, so any 24-char base32hex core plus `[a-z0-9]` plus "2" parses as
// a gen-2 id naming a shard — including a shard no topology configures. The run routes already
// answer 404 for that, but the waitpoint-token routes wrap their body in a catch that turns every
// non-Response error into a 500, so a caller could induce a 5xx (and trip a canary) at will.
//
// Both routes are driven for real: the routing store is a REAL RoutingRunStore (it is the thing that
// throws UnknownShardKey, from its own id-shape routing — the sub-stores are never reached), and the
// route code under test is the exported action / the handler the api-builder captured.
import { describe, expect, vi } from "vitest";

const H = vi.hoisted(() => ({
  handlers: [] as Array<{ config: any; handler: any }>,
  store: undefined as any,
}));

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = H.store;
        if (!store) throw new Error("test bug: H.store not initialised before handler ran");
        const value = store[prop];
        return typeof value === "function" ? value.bind(store) : value;
      },
    }
  ),
}));

vi.mock("~/services/routeBuilders/apiBuilder.server", () => ({
  anyResource: (x: unknown) => x,
  createActionApiRoute: (config: any, handler: any) => {
    H.handlers.push({ config, handler });
    return { action: vi.fn(), loader: vi.fn() };
  },
}));

import { RoutingRunStore, type RunStore } from "@internal/run-store";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { action as callbackAction } from "~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.callback.$hash";

// 24-char base32hex core + shard char "z" + version "2": a well-formed gen-2 id whose shard the
// router below has no store for.
const UNCONFIGURED_SHARD_WAITPOINT_ID = "waitpoint_" + "c".repeat(24) + "z2";

// Only "new" and "legacy" are configured, so a gen-2 id lands on UnknownShardKey inside the router.
// The sub-stores are unreachable placeholders: the throw happens before any of them is consulted.
function routerWithNoShards() {
  const unreachable = new Proxy(
    {},
    {
      get() {
        throw new Error("no sub-store should be reached for an unconfigured shard key");
      },
    }
  ) as RunStore;
  return new RoutingRunStore({ new: unreachable, legacy: unreachable });
}

async function completeHandler() {
  await import("~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.complete");
  const entry = H.handlers.find((h) => Boolean(h.config?.params?.shape?.waitpointFriendlyId));
  if (!entry) throw new Error("complete-route handler was not captured");
  return entry.handler as (args: any) => Promise<Response>;
}

describe("waitpoint-token routes with an id naming an unconfigured shard", () => {
  it("answers 404, not 500, on the token completion route", async () => {
    H.store = routerWithNoShards();
    const handler = await completeHandler();

    const thrown = await handler({
      authentication: { environment: { id: "env_1" } },
      body: { data: { ok: true } },
      params: { waitpointFriendlyId: WaitpointId.toFriendlyId(UNCONFIGURED_SHARD_WAITPOINT_ID) },
    }).then(
      (response) => response,
      (error) => error
    );

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    // Not retryable: no number of retries makes a topology grow a store.
    expect((thrown as Response).headers.get("x-should-retry")).toBe("false");
  });

  it("answers 404, not 500, on the HTTP-callback route", async () => {
    H.store = routerWithNoShards();

    const payload = JSON.stringify({ ok: true });
    const response = await callbackAction({
      request: new Request("http://localhost/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(payload.length) },
        body: payload,
      }),
      params: {
        waitpointFriendlyId: WaitpointId.toFriendlyId(UNCONFIGURED_SHARD_WAITPOINT_ID),
        hash: "whatever",
      },
      context: {},
    } as any);

    expect(response.status).toBe(404);
  });
});
