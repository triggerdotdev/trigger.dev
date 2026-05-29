import { describe, it, expect } from "vitest";
import { InitializeDeploymentRequestBody } from "./api.js";
import type { InitializeDeploymentRequestBody as InitializeDeploymentRequestBodyType } from "./api.js";

describe("InitializeDeploymentRequestBody", () => {
  const base = { contentHash: "abc123" };

  describe("non-native build variant (isNativeBuild omitted or false)", () => {
    it("parses with only required fields", () => {
      const result = InitializeDeploymentRequestBody.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isNativeBuild).toBe(false);
      }
    });

    it("parses with isNativeBuild explicitly false", () => {
      const result = InitializeDeploymentRequestBody.safeParse({ ...base, isNativeBuild: false });
      expect(result.success).toBe(true);
    });

    it("parses with optional base fields", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        userId: "user_1",
        type: "MANAGED",
        runtime: "node",
        initialStatus: "PENDING",
      });
      expect(result.success).toBe(true);
    });

    it("strips native-only fields when isNativeBuild is false", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: false,
        skipPromotion: true,
      });
      // Zod discriminatedUnion matches the non-native branch and strips unknown keys
      expect(result.success).toBe(true);
      if (result.success) {
        expect("skipPromotion" in result.data).toBe(false);
      }
    });
  });

  describe("native build variant (isNativeBuild: true)", () => {
    it("parses with isNativeBuild true", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isNativeBuild).toBe(true);
      }
    });

    it("parses with native-specific optional fields", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: true,
        skipPromotion: true,
        artifactKey: "artifact_abc",
        configFilePath: "trigger.config.ts",
        skipEnqueue: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipPromotion).toBe(true);
        expect(result.data.artifactKey).toBe("artifact_abc");
        expect(result.data.configFilePath).toBe("trigger.config.ts");
        expect(result.data.skipEnqueue).toBe(true);
      }
    });

    it("skipEnqueue defaults to false when omitted", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipEnqueue).toBe(false);
      }
    });
  });

  describe("rejects invalid inputs", () => {
    it("rejects missing contentHash", () => {
      const result = InitializeDeploymentRequestBody.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects invalid type enum value", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        type: "INVALID",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid initialStatus enum value", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        initialStatus: "RUNNING",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type-level checks", () => {
    it("native variant exposes native-specific fields", () => {
      const result = InitializeDeploymentRequestBody.parse({
        ...base,
        isNativeBuild: true,
        skipPromotion: true,
      });

      if (result.isNativeBuild === true) {
        const _skipPromotion: boolean | undefined = result.skipPromotion;
        const _artifactKey: string | undefined = result.artifactKey;
        const _configFilePath: string | undefined = result.configFilePath;
        expect(_skipPromotion).toBe(true);
        expect(_artifactKey).toBeUndefined();
        expect(_configFilePath).toBeUndefined();
      }
    });

    it("non-native variant narrows correctly", () => {
      const result: InitializeDeploymentRequestBodyType =
        InitializeDeploymentRequestBody.parse(base);

      if (!result.isNativeBuild) {
        // Should only have base fields — native-specific fields should not exist
        const narrowed: { isNativeBuild?: false; contentHash: string } = result;
        expect(narrowed.contentHash).toBe("abc123");
      }
    });
  });
});
