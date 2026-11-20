import { describe, expect, it } from "vitest";
import { initialUsageAuth } from "~/v3/services/worker/usageJwtRefresh.server";

const base = {
  supportsUsageJwtRefresh: true,
  verifiedEnvironmentId: "env_1",
  environmentId: "env_1",
  hasRootKey: false,
};

describe("initialUsageAuth", () => {
  it("issues a control-plane credential to a verified runner without the root key", () => {
    expect(initialUsageAuth(base)).toBe("control_plane");
  });

  // Catches: a run that holds the root key losing API-key recovery of its credential.
  it("keeps runs with the root key on API-key renewal", () => {
    expect(initialUsageAuth({ ...base, hasRootKey: true })).toBe("legacy_root_key");
  });

  // Catches: a run failing, or getting a credential nothing can renew, when the supervisor did not verify it.
  it("falls back when the environment is unverified or mismatched", () => {
    expect(initialUsageAuth({ ...base, verifiedEnvironmentId: undefined })).toBe(
      "legacy_unverified"
    );
    expect(initialUsageAuth({ ...base, verifiedEnvironmentId: "env_2" })).toBe("legacy_unverified");
  });

  it("keeps runners without renewal support on the legacy path", () => {
    expect(initialUsageAuth({ ...base, supportsUsageJwtRefresh: false })).toBe("legacy_runner");
  });
});
