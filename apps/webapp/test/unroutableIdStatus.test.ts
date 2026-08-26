// `resolveShard` is pure id-shape, so any base32hex core plus `[a-z0-9]` plus "2" parses as gen-2
// and names a shard — including one a caller invents. The routing store throws for a key it has no
// store for, which is correct and deliberately loud, but a read route that lets it reach the
// boundary answered 500 for caller-supplied input. These tests pin the boundary status.
import { describe, expect, it } from "vitest";
import { json } from "@remix-run/server-runtime";
import { UnknownShardKey } from "@internal/run-store";
import { unroutableIdResponse } from "~/services/routeBuilders/unroutableId.server";

describe("unroutableIdResponse", () => {
  it("answers 404 for an id naming a shard with no configured store", async () => {
    const response = unroutableIdResponse(new UnknownShardKey("z", ["legacy", "new"]));

    expect(response).toBeDefined();
    expect(response!.status).toBe(404);
    await expect(response!.json()).resolves.toEqual({ error: "Not Found" });
  });

  it("declines an unrelated error so it still reaches the 500 path", () => {
    expect(unroutableIdResponse(new Error("db down"))).toBeUndefined();
    expect(unroutableIdResponse(undefined)).toBeUndefined();
    expect(unroutableIdResponse("a string")).toBeUndefined();
  });

  it("declines a deliberately thrown Response, which carries its own status", () => {
    expect(unroutableIdResponse(json({ error: "nope" }, { status: 422 }))).toBeUndefined();
  });

  it("keeps the key and the configured set on the error for the operator", () => {
    // A 404 to the caller must not cost the operator what separates a forged id from a shard
    // key dropped out of a config that is meant to be append-only.
    const error = new UnknownShardKey("z", ["legacy", "new", "a"]);

    expect(error.shardKey).toBe("z");
    expect(error.configured).toContain("a");
  });
});
