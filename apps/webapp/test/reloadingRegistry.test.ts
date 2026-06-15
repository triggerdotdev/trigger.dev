import { describe, it, expect, vi } from "vitest";
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

  it("newer load wins even if an older load resolves later", async () => {
    // load hands the test a deferred resolver per call so completion order is controllable.
    const deferred: Array<(value: number) => void> = [];
    const reg = createReloadingRegistry({
      name: "test-e",
      intervalMs: 10_000,
      load: () =>
        new Promise<number>((resolve) => {
          deferred.push(resolve);
        }),
    });

    // deferred[0] is the startup load; let it complete with an initial value.
    deferred[0](0);
    await reg.isReady;

    // start two overlapping loads; don't await yet (deferred[1] older, deferred[2] newer)
    const older = reg.reload();
    const newer = reg.reload();

    // resolve the NEWER load first, then the OLDER load last
    deferred[2](2);
    deferred[1](1);
    await Promise.all([older, newer]);

    // the older load completing last must NOT clobber the newer snapshot
    expect(reg.current()).toBe(2);
    reg.stop();
  });

  it("waitUntilReady clears its timeout when ready wins", async () => {
    const clearSpy = vi.spyOn(global, "clearTimeout");
    // load resolves only when the test releases it, so waitUntilReady runs the
    // race while still unloaded (it would return early if already loaded)
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const reg = createReloadingRegistry({
      name: "test-f",
      intervalMs: 10_000,
      load: async () => {
        await loadGate;
        return 1;
      },
    });

    // long timeout so isReady is what actually wins the race
    const waiting = reg.waitUntilReady(10_000);
    releaseLoad();
    await reg.isReady;
    await waiting;

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    reg.stop();
  });
});
