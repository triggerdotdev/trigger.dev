// The base must forward EVERY RunStore member. A method added to the interface and not to the base
// is a silent hole in the decorator built on top of it, so this suite enumerates the generated name
// lists rather than restating them by hand. Regenerate the base and both lists together:
//   pnpm exec tsx scripts/generateDelegatingRunStore.ts
import { describe, expect, it } from "vitest";
import { DelegatingRunStore } from "./delegatingRunStore.js";
import { RUN_STORE_METHOD_NAMES, RUN_STORE_PROPERTY_NAMES } from "./runStoreMethodNames.js";
import type { RunStore } from "./types.js";

function recordingDelegate(): { store: RunStore; calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = [];
  const store: Record<string, unknown> = {};

  for (const name of RUN_STORE_METHOD_NAMES) {
    store[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      return `result:${name}`;
    };
  }
  for (const name of RUN_STORE_PROPERTY_NAMES) {
    store[name] = `property:${name}`;
  }

  return { store: store as unknown as RunStore, calls };
}

describe("DelegatingRunStore", () => {
  it("forwards every RunStore method to the delegate, arguments untouched", () => {
    const { store, calls } = recordingDelegate();
    const base = new DelegatingRunStore(store) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    for (const name of RUN_STORE_METHOD_NAMES) {
      expect(base[name]("arg-one", "arg-two")).toBe(`result:${name}`);
    }

    expect(calls.map((c) => c.name)).toEqual([...RUN_STORE_METHOD_NAMES]);
    for (const call of calls) {
      expect(call.args).toEqual(["arg-one", "arg-two"]);
    }
  });

  it("reads every RunStore data property from the delegate", () => {
    const { store } = recordingDelegate();
    const base = new DelegatingRunStore(store) as unknown as Record<string, unknown>;

    for (const name of RUN_STORE_PROPERTY_NAMES) {
      expect(base[name]).toBe(`property:${name}`);
    }
  });

  it("reads a data property live, so a delegate that changes is not cached", () => {
    const store = { primaryReadClient: "first" } as unknown as RunStore;
    const base = new DelegatingRunStore(store);

    expect(base.primaryReadClient).toBe("first" as unknown);
    (store as unknown as Record<string, unknown>).primaryReadClient = "second";
    expect(base.primaryReadClient).toBe("second" as unknown);
  });

  it("declares exactly the members the interface declares, and no others", () => {
    const own = Object.getOwnPropertyNames(DelegatingRunStore.prototype)
      .filter((name) => name !== "constructor")
      .sort();

    const expected = [...RUN_STORE_METHOD_NAMES, ...RUN_STORE_PROPERTY_NAMES].sort();

    expect(own).toEqual(expected);
  });
});
