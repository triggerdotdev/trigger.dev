// What this suite covers, and why it does not use a container.
//
// `DelegatingRunStore` is generated and holds no logic: every member forwards to a delegate. Three
// properties of it are already proved by the compiler and are NOT retested here:
//
//   - a member of the interface missing from the class      -> `implements RunStore`, TS2420
//   - a public member the interface does not declare        -> the parity assertion in the base
//   - a name list out of step with the interface            -> the assertions in runStoreMethodNames
//
// What the compiler cannot see is inside the forwarder bodies, because each one is typed
// `(...args: any[]): any`. A forwarder wired to the wrong delegate method, dropping an argument, or
// reading a property once at construction instead of on each access, all typecheck cleanly. Those
// are template-correctness properties of the generator's output, and they are what is tested below.
//
// A Testcontainers-backed store cannot demonstrate them. It would mean calling all 70 methods with
// valid arguments and valid foreign-key state, and a real return value cannot show that arguments
// arrived untouched the way a per-member sentinel can. The probe below is not a stand-in for a
// database: no database is involved in whether a pass-through passes through. Behaviour against a
// real store is covered by the container suites for the decorator built on this base.
import { describe, expect, it } from "vitest";
import { DelegatingRunStore } from "./delegatingRunStore.js";
import { RUN_STORE_METHOD_NAMES, RUN_STORE_PROPERTY_NAMES } from "./runStoreMethodNames.js";
import type { RunStore } from "./types.js";

type ProbedCall = { name: string; args: unknown[] };

/**
 * A delegate that records what was called on it and answers with a per-member sentinel, so a
 * forwarder wired to the wrong member returns the wrong sentinel and fails loudly.
 */
function forwardingProbe(): { store: RunStore; calls: ProbedCall[] } {
  const calls: ProbedCall[] = [];

  const store = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if ((RUN_STORE_PROPERTY_NAMES as readonly string[]).includes(prop)) {
        return `property:${prop}`;
      }
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        return `result:${prop}`;
      };
    },
  });

  return { store: store as unknown as RunStore, calls };
}

describe("DelegatingRunStore", () => {
  it("forwards every method to the member of the same name", () => {
    const { store, calls } = forwardingProbe();
    const base = new DelegatingRunStore(store) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    for (const name of RUN_STORE_METHOD_NAMES) {
      // The sentinel is per member, so a body forwarding to a different method fails here rather
      // than passing because both happened to return something.
      expect(base[name]()).toBe(`result:${name}`);
    }

    expect(calls.map((c) => c.name)).toEqual([...RUN_STORE_METHOD_NAMES]);
  });

  it("forwards arguments untouched", () => {
    const { store, calls } = forwardingProbe();
    const base = new DelegatingRunStore(store) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const args = ["first", { second: true }, undefined, 4];

    for (const name of RUN_STORE_METHOD_NAMES) {
      base[name](...args);
    }

    for (const call of calls) {
      expect(call.args).toEqual(args);
    }
  });

  it("reads a data property live, so a delegate that changes is not cached", () => {
    // A getter is the only correct shape here. Capturing the value in the constructor would
    // typecheck and would then serve a stale client for the life of the decorator.
    const store = { primaryReadClient: "first" } as unknown as RunStore;
    const base = new DelegatingRunStore(store);

    expect(base.primaryReadClient).toBe("first" as unknown);
    (store as unknown as Record<string, unknown>).primaryReadClient = "second";
    expect(base.primaryReadClient).toBe("second" as unknown);
  });
});
