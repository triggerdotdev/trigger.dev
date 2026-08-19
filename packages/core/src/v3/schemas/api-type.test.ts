import { describe, it, expect } from "vitest";
import {
  BatchItemNDJSON,
  InitializeDeploymentRequestBody,
  nodeMajor,
  TriggerTaskRequestBody,
} from "./api.js";
import type { InitializeDeploymentRequestBody as InitializeDeploymentRequestBodyType } from "./api.js";

describe("nodeMajor", () => {
  it.each([
    ["node", "20.18.0", 20],
    ["node", "21.7.3", 21],
    ["node-22", "22.16.0", 22],
    ["node-24", "24.18.0", 24],
    ["bun", "1.3.3", undefined],
    ["node", null, undefined],
    ["node", "unknown", undefined],
  ])("resolves %s %s", (runtime, runtimeVersion, expected) => {
    expect(nodeMajor(runtime, runtimeVersion)).toBe(expected);
  });
});

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

  describe("externalId and force", () => {
    it("accepts an externalId on the non-native variant", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "a1b2c3d4e5f6",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.externalId).toBe("a1b2c3d4e5f6");
      }
    });

    it("accepts an externalId on the native variant", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: true,
        externalId: "a1b2c3d4e5f6",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.externalId).toBe("a1b2c3d4e5f6");
      }
    });

    it("accepts a free-form externalId, imposing no format", () => {
      for (const externalId of [
        "refs/tags/v1.2.3_rc:4-final",
        "release 2026-08-07",
        "build #4821",
        "déployé-en-français",
        "🚀 ship it",
        '{"run":42}',
      ]) {
        const result = InitializeDeploymentRequestBody.safeParse({ ...base, externalId });
        expect(result.success, `expected ${externalId} to be accepted`).toBe(true);
        if (result.success) {
          expect(result.data.externalId).toBe(externalId);
        }
      }
    });

    it("trims surrounding whitespace but keeps whitespace inside the value", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "  release 2026-08-07  ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.externalId).toBe("release 2026-08-07");
      }
    });

    it("treats a blank externalId as absent", () => {
      const result = InitializeDeploymentRequestBody.safeParse({ ...base, externalId: "" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.externalId).toBeUndefined();
      }
    });

    it("treats a whitespace-only externalId as absent", () => {
      const result = InitializeDeploymentRequestBody.safeParse({ ...base, externalId: "   " });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.externalId).toBeUndefined();
      }
    });

    it("accepts an externalId of exactly 128 characters", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "a".repeat(128),
      });
      expect(result.success).toBe(true);
    });

    it("accepts a 64-character SHA-256 commit hash", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "a".repeat(64),
      });
      expect(result.success).toBe(true);
    });

    it("accepts a 40-character commit SHA", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "e3f1c0a9b7d24e5f6081a2b3c4d5e6f708192a3b",
      });
      expect(result.success).toBe(true);
    });

    it("rejects an externalId longer than 128 characters", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "a".repeat(129),
      });
      expect(result.success).toBe(false);
    });

    it("names the limit in the rejection message", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "a".repeat(129),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("externalId must be at most 128 characters");
      }
    });

    it("measures the length limit after trimming", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: `  ${"a".repeat(128)}  `,
      });
      expect(result.success).toBe(true);
    });

    it("leaves force absent when omitted, which reads as not forced", () => {
      const result = InitializeDeploymentRequestBody.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force ?? false).toBe(false);
      }
    });

    it("accepts force alongside an externalId", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "a1b2c3",
        force: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBe(true);
      }
    });

    it("rejects force without an externalId", () => {
      const result = InitializeDeploymentRequestBody.safeParse({ ...base, force: true });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("force requires externalId");
      }
    });

    it("rejects force when the externalId is blank", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        externalId: "  ",
        force: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects force without an externalId on the native variant too", () => {
      const result = InitializeDeploymentRequestBody.safeParse({
        ...base,
        isNativeBuild: true,
        force: true,
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

describe("TriggerTaskRequestBody", () => {
  it("accepts application/store payload as a non-empty string", () => {
    const result = TriggerTaskRequestBody.safeParse({
      payload: "packets/payloads/file.json",
      context: {},
      options: {
        payloadType: "application/store",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects application/store payload when payload is not a string", () => {
    const result = TriggerTaskRequestBody.safeParse({
      payload: { foo: "bar" },
      context: {},
      options: {
        payloadType: "application/store",
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects application/store payload when payload is an empty string", () => {
    const result = TriggerTaskRequestBody.safeParse({
      payload: "",
      context: {},
      options: {
        payloadType: "application/store",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts an optional payloadSize on the options", () => {
    const result = TriggerTaskRequestBody.safeParse({
      payload: "packets/payloads/file.json",
      context: {},
      options: {
        payloadType: "application/store",
        payloadSize: 512 * 1024,
      },
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.options?.payloadSize).toBe(512 * 1024);
  });

  it("rejects a negative payloadSize", () => {
    const result = TriggerTaskRequestBody.safeParse({
      payload: { foo: "bar" },
      context: {},
      options: {
        payloadSize: -1,
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("BatchItemNDJSON", () => {
  it("accepts an optional payloadSize on a batch item's options", () => {
    const result = BatchItemNDJSON.safeParse({
      index: 0,
      task: "my-task",
      payload: "packets/payloads/file.json",
      options: {
        payloadType: "application/store",
        payloadSize: 256 * 1024,
      },
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.options?.payloadSize).toBe(256 * 1024);
  });
});
