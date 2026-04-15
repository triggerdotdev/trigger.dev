import { apiClientManager } from "../src/v3/apiClientManager-api.js";

const originalEnv = process.env.TRIGGER_VERSION;

describe("APIClientManagerAPI.resolveLockToVersion", () => {
  beforeEach(() => {
    delete process.env.TRIGGER_VERSION;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TRIGGER_VERSION;
    } else {
      process.env.TRIGGER_VERSION = originalEnv;
    }
    apiClientManager.disable();
  });

  describe("without a scope override", () => {
    it("returns undefined when no call version is given and TRIGGER_VERSION is unset", () => {
      expect(apiClientManager.resolveLockToVersion()).toBeUndefined();
    });

    it("falls back to TRIGGER_VERSION when no call version is given", () => {
      process.env.TRIGGER_VERSION = "20250101.1";
      expect(apiClientManager.resolveLockToVersion()).toBe("20250101.1");
    });

    it("prefers a per-call version string over TRIGGER_VERSION", () => {
      process.env.TRIGGER_VERSION = "20250101.1";
      expect(apiClientManager.resolveLockToVersion("20250202.1")).toBe("20250202.1");
    });

    it("returns undefined when per-call version is null, even if TRIGGER_VERSION is set", () => {
      process.env.TRIGGER_VERSION = "20250101.1";
      expect(apiClientManager.resolveLockToVersion(null)).toBeUndefined();
    });
  });

  describe("inside a scope with a version string", () => {
    it("uses the scoped version when no call version is given", async () => {
      process.env.TRIGGER_VERSION = "20250101.1";

      await apiClientManager.runWithConfig({ version: "20250303.1" }, async () => {
        expect(apiClientManager.resolveLockToVersion()).toBe("20250303.1");
      });
    });

    it("lets a per-call version string win over the scope", async () => {
      await apiClientManager.runWithConfig({ version: "20250303.1" }, async () => {
        expect(apiClientManager.resolveLockToVersion("20250404.1")).toBe("20250404.1");
      });
    });

    it("lets a per-call null win over the scope", async () => {
      await apiClientManager.runWithConfig({ version: "20250303.1" }, async () => {
        expect(apiClientManager.resolveLockToVersion(null)).toBeUndefined();
      });
    });
  });

  describe("inside a scope with version: null", () => {
    it("ignores TRIGGER_VERSION when no call version is given", async () => {
      process.env.TRIGGER_VERSION = "20250101.1";

      await apiClientManager.runWithConfig({ version: null }, async () => {
        expect(apiClientManager.resolveLockToVersion()).toBeUndefined();
      });
    });

    it("lets a per-call version string win over the null scope", async () => {
      await apiClientManager.runWithConfig({ version: null }, async () => {
        expect(apiClientManager.resolveLockToVersion("20250505.1")).toBe("20250505.1");
      });
    });
  });

  describe("scope without a version key", () => {
    it("falls back to TRIGGER_VERSION", async () => {
      process.env.TRIGGER_VERSION = "20250101.1";

      await apiClientManager.runWithConfig({ accessToken: "tr_test_xyz" }, async () => {
        expect(apiClientManager.resolveLockToVersion()).toBe("20250101.1");
      });
    });

    it("still respects a per-call null", async () => {
      process.env.TRIGGER_VERSION = "20250101.1";

      await apiClientManager.runWithConfig({ accessToken: "tr_test_xyz" }, async () => {
        expect(apiClientManager.resolveLockToVersion(null)).toBeUndefined();
      });
    });
  });

  describe("scope with version: undefined explicitly", () => {
    it("treats explicit undefined as 'no key' and falls back to TRIGGER_VERSION", async () => {
      process.env.TRIGGER_VERSION = "20250101.1";

      await apiClientManager.runWithConfig({ version: undefined }, async () => {
        expect(apiClientManager.resolveLockToVersion()).toBe("20250101.1");
      });
    });
  });
});
