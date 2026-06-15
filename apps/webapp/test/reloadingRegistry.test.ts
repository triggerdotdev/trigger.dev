import { describe, it, expect } from "vitest";
import { createReloadingRegistry } from "~/utils/reloadingRegistry.server";

describe("createReloadingRegistry", () => {
  it("current() is undefined before load, snapshot after isReady", async () => {
    const reg = createReloadingRegistry({
      name: "test-a",
      intervalMs: 10_000,
      load: async () => ({ value: 42 }),
    });
    expect(reg.current()).toBeUndefined();
    await reg.isReady;
    expect(reg.isLoaded).toBe(true);
    expect(reg.current()).toEqual({ value: 42 });
    reg.stop();
  });

  it("waitUntilReady resolves once loaded", async () => {
    const reg = createReloadingRegistry({
      name: "test-b",
      intervalMs: 10_000,
      load: async () => 1,
    });
    await reg.waitUntilReady(1000);
    expect(reg.current()).toBe(1);
    reg.stop();
  });

  it("waitUntilReady times out (and stays unloaded) when load never succeeds", async () => {
    const reg = createReloadingRegistry({
      name: "test-c",
      intervalMs: 10_000,
      retry: { retries: 0 },
      load: async () => {
        throw new Error("db down");
      },
    });
    await reg.waitUntilReady(50);
    expect(reg.isLoaded).toBe(false);
    expect(reg.current()).toBeUndefined();
    reg.stop();
  });

  it("reload() picks up a changed value", async () => {
    let v = 1;
    const reg = createReloadingRegistry({
      name: "test-d",
      intervalMs: 10_000,
      load: async () => v,
    });
    await reg.isReady;
    expect(reg.current()).toBe(1);
    v = 2;
    await reg.reload();
    expect(reg.current()).toBe(2);
    reg.stop();
  });
});
