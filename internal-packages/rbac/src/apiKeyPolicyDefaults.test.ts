import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";

// The API-key policy methods are OPTIONAL on RoleBaseAccessController so a
// plugin compiled against an older OSS commit still satisfies the contract
// (the plugin is built against whichever OSS source its base image carries).
// LazyController is what turns that partial surface into a total one, and these
// tests pin the defaults it substitutes — in particular that a missing
// prepareApiKeyPolicy fails CLOSED rather than resolving to full access.
//
// A stand-in for the cloud plugin, which isn't installed in this repo. The
// factory supplies the specifier, so no real module has to resolve.
vi.mock("@triggerdotdev/plugins/rbac", () => ({
  default: {
    create: () => ({
      // Deliberately omits apiKeyPresets / prepareApiKeyPolicy /
      // describeApiKeyPolicy — this is a pre-contract plugin.
      isUsingPlugin: async () => true,
    }),
  },
}));

const prismaPlaceholder = {} as unknown as PrismaClient;

describe("LazyController API-key policy defaults (plugin predates the contract)", () => {
  async function controller() {
    const loader = (await import("./index.js")).default;
    const instance = loader.create(prismaPlaceholder);
    // Guard against a silent fallback: if the mock didn't take, these
    // assertions would be checking the fallback's real implementations.
    await expect(instance.isUsingPlugin()).resolves.toBe(true);
    return instance;
  }

  it("reports no preset catalogue rather than throwing", async () => {
    await expect((await controller()).apiKeyPresets("org_123")).resolves.toBeNull();
  });

  it("refuses to prepare a policy — including FULL_ACCESS", async () => {
    const result = await (
      await controller()
    ).prepareApiKeyPolicy({
      organizationId: "org_123",
      presetId: "FULL_ACCESS",
    });

    // The critical assertion: absence must never resolve to `{ ok: true }` with
    // an admin scope. A plugin below the contract cannot mint any credential.
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("policy");
  });

  it("describes a policy as having nothing extra to show", async () => {
    await expect(
      (await controller()).describeApiKeyPolicy({ presetId: "TRIGGER_ONLY", scopes: ["read:runs"] })
    ).resolves.toEqual({});
  });
});
