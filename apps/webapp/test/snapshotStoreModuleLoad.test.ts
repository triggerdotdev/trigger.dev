import { describe, expect, it, vi } from "vitest";

// Reproduces the CI break. Many webapp suites mock ~/db.server and ~/env.server with minimal
// objects, so a module-load side effect that reads a new env variable takes the whole file down on
// import. This is the exact mock shape of the suite that caught it.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/services/logger.server", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

describe("snapshot store modules under a minimal env mock", () => {
  it("imports the mode resolver without constructing anything", async () => {
    await expect(import("~/v3/snapshotStoreMode.server")).resolves.toBeDefined();
  });

  it("resolves off rather than throwing", async () => {
    const { snapshotStoreModeResolver } = await import("~/v3/snapshotStoreMode.server");
    expect(snapshotStoreModeResolver.resolve()).toBe("off");
    expect(snapshotStoreModeResolver.resolve("org_anything")).toBe("off");
  });

  it("imports the instance module and stays undecorated", async () => {
    const mod = await import("~/v3/snapshotStoreInstance.server");
    const sentinel = {} as never;
    expect(mod.decorateWithSnapshotStore(sentinel)).toBe(sentinel);
    expect(mod.getSnapshotSweepClient()).toBeUndefined();
  });
});
