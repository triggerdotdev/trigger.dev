import { describe, expect, it } from "vitest";
import { createStartupNodeLookup, type StartupNodeLookupOptions } from "./startupNodeLookup.js";

type ResolveAll = NonNullable<StartupNodeLookupOptions["resolve"]>;

// TEST-NET-1: never routed, so a connection to it neither succeeds nor is refused.
const DEAD_ADDRESS = "192.0.2.1";
const STARTUP_HOST = "cluster.store.test";

const fixedAddresses =
  (...addresses: string[]): ResolveAll =>
  (_hostname, _options, callback) =>
    callback(
      null,
      addresses.map((address) => ({ address, family: 4 }))
    );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createStartupNodeLookup", () => {
  it("skips an address that recently failed and returns it once the penalty expires", async () => {
    const lookup = createStartupNodeLookup({
      penaltyMs: 200,
      resolve: fixedAddresses(DEAD_ADDRESS, "127.0.0.1"),
    });
    const pick = () =>
      new Promise<string>((resolve, reject) =>
        lookup.dnsLookup(STARTUP_HOST, (error, address) =>
          error ? reject(error) : resolve(address)
        )
      );

    lookup.markFailed(`${DEAD_ADDRESS}:6379`);
    const whilePenalised = await Promise.all(Array.from({ length: 20 }, pick));
    expect(new Set(whilePenalised)).toEqual(new Set(["127.0.0.1"]));

    await sleep(250);
    const afterPenalty = await Promise.all(Array.from({ length: 40 }, pick));
    expect(afterPenalty).toContain(DEAD_ADDRESS);
  });
});
