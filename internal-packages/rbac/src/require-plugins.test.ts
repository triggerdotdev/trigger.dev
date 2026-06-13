import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import loader from "./index.js";

// The plugin module `@triggerdotdev/plugins/rbac` is not installed in this
// repo (it lives in the cloud monorepo), so a real dynamic import inside
// the loader will reliably fail with ERR_MODULE_NOT_FOUND. These tests
// exercise the loader's branching on that natural failure — no module
// mocking required.

// The fallback's isUsingPlugin() returns false synchronously without
// touching prisma, so a placeholder client is fine for tests that only
// drive the loader path.
const prismaPlaceholder = {} as unknown as PrismaClient;

describe("LazyController plugin loading", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back silently when REQUIRE_PLUGINS is unset and the plugin is missing", async () => {
    vi.stubEnv("REQUIRE_PLUGINS", "");
    const controller = loader.create(prismaPlaceholder);
    await expect(controller.isUsingPlugin()).resolves.toBe(false);
  });

  it("throws when REQUIRE_PLUGINS=1 and the plugin is missing", async () => {
    vi.stubEnv("REQUIRE_PLUGINS", "1");
    const controller = loader.create(prismaPlaceholder);
    await expect(controller.isUsingPlugin()).rejects.toThrow(/REQUIRE_PLUGINS=1/);
  });

  it("forceFallback wins over REQUIRE_PLUGINS=1 (so tests inheriting the env aren't broken)", async () => {
    vi.stubEnv("REQUIRE_PLUGINS", "1");
    const controller = loader.create(prismaPlaceholder, { forceFallback: true });
    await expect(controller.isUsingPlugin()).resolves.toBe(false);
  });

  it("treats any non-'1' REQUIRE_PLUGINS value as unset (must be exactly '1' to enforce)", async () => {
    vi.stubEnv("REQUIRE_PLUGINS", "true");
    const controller = loader.create(prismaPlaceholder);
    await expect(controller.isUsingPlugin()).resolves.toBe(false);
  });
});
