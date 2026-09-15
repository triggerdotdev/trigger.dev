// What this suite covers, and why it is now small.
//
// `DelegatingRunStore` restates every interface signature and forwards its arguments by name, so
// most of what a pass-through can get wrong is a compile error rather than a test failure:
//
//   member of the interface missing         -> `implements RunStore`, TS2420
//   public member the interface lacks       -> the parity assertion in the base
//   forwarded to the wrong delegate member  -> argument types do not match, TS2345/TS2322
//   arguments reordered                     -> same
//
// Three things remain invisible to the compiler, and they are what is left here.
//
// First, the seven overloaded members. TypeScript cannot express one body that satisfies an overload
// set, so their single implementation forwards through a cast, and the cast is exactly where a
// wrong-member forward would stop being a type error.
//
// Second, a dropped OPTIONAL argument. Omitting a trailing `tx` compiles cleanly and silently stops
// forwarding the caller's transaction.
//
// Third, whether a data property is read live or captured once at construction. Both typecheck; only
// one is correct.
//
// No database is involved in whether a pass-through passes through, so none is started. Behaviour
// against a real store is covered by the container suites for the decorator built on this base.
import { describe, expect, it } from "vitest";
import { DelegatingRunStore } from "./delegatingRunStore.js";
import { RUN_STORE_METHOD_NAMES, RUN_STORE_PROPERTY_NAMES } from "./runStoreMethodNames.js";
import type { RunStore } from "./types.js";

/**
 * The members whose implementation forwards through a cast, because they are overloaded. These are
 * the only methods where the compiler is not already checking the forward.
 */
const OVERLOADED_MEMBERS = [
  "finalizeRun",
  "findRun",
  "findRunOrThrow",
  "findRunOnPrimary",
  "findRunOrThrowOnPrimary",
  "findRuns",
  "findRunsByIds",
] as const;

type ProbedCall = { name: string; args: unknown[] };

/**
 * Records what was called and answers with a per-member sentinel, so a forward to the wrong member
 * returns the wrong value rather than merely returning something.
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
      expect(base[name]()).toBe(`result:${name}`);
    }

    expect(calls.map((c) => c.name)).toEqual([...RUN_STORE_METHOD_NAMES]);
  });

  it("covers every overloaded member, so the list cannot rot", () => {
    // If a member gains or loses overloads, the cast set changes and this suite should follow.
    for (const name of OVERLOADED_MEMBERS) {
      expect(RUN_STORE_METHOD_NAMES).toContain(name);
    }
  });

  it("forwards arguments untouched through an overloaded member's cast", () => {
    const { store, calls } = forwardingProbe();
    const base = new DelegatingRunStore(store) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const args = ["first", { second: true }, undefined, 4];

    for (const name of OVERLOADED_MEMBERS) {
      base[name](...args);
    }

    // The overloaded implementations apply the whole argument list, so every argument survives,
    // including a trailing optional the typed members would legitimately drop.
    for (const call of calls) {
      expect(call.args).toEqual(args);
    }
    expect(calls.map((c) => c.name)).toEqual([...OVERLOADED_MEMBERS]);
  });

  it("reads a data property live, so a delegate that changes is not cached", () => {
    const store = { primaryReadClient: "first" } as unknown as RunStore;
    const base = new DelegatingRunStore(store);

    expect(base.primaryReadClient).toBe("first" as unknown);
    (store as unknown as Record<string, unknown>).primaryReadClient = "second";
    expect(base.primaryReadClient).toBe("second" as unknown);
  });
});
