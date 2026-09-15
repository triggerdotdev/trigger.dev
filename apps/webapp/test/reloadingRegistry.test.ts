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

  it("autoStart:false stays inert (never loads)", async () => {
    let loadCalls = 0;
    const reg = createReloadingRegistry({
      name: "test-inert",
      intervalMs: 10_000,
      autoStart: false,
      load: async () => {
        loadCalls++;
        return 1;
      },
    });
    expect(reg.isLoaded).toBe(false);
    expect(reg.current()).toBeUndefined();
    expect(loadCalls).toBe(0); // never hit the DB/load
    reg.stop();
  });
});
