import { describe, expect, test } from "vitest";
import {
  encodeQueueMember,
  decodeQueueMember,
  encodeWorkerQueueEntry,
  decodeWorkerQueueEntry,
  isEncodedQueueMember,
  isEncodedWorkerQueueEntry,
  getRunIdFromMember,
  reconstructMessageFromWorkerEntry,
} from "../messageEncoding.js";

describe("messageEncoding", () => {
  describe("isEncodedQueueMember", () => {
    test("returns true for v3 encoded member", () => {
      const encoded = encodeQueueMember({
        runId: "run_abc123",
        workerQueue: "env_xyz",
        attempt: 0,
        environmentType: "PRODUCTION",
      });
      expect(isEncodedQueueMember(encoded)).toBe(true);
    });

    test("returns false for legacy member (just runId)", () => {
      expect(isEncodedQueueMember("run_abc123")).toBe(false);
    });
  });

  describe("isEncodedWorkerQueueEntry", () => {
    test("returns true for v3 encoded entry", () => {
      const encoded = encodeWorkerQueueEntry({
        runId: "run_abc123",
        workerQueue: "env_xyz",
        attempt: 0,
        environmentType: "PRODUCTION",
        queueKey: "{org:o123}:proj:p123:env:e123:queue:my-task",
        timestamp: 1706812800000,
      });
      expect(isEncodedWorkerQueueEntry(encoded)).toBe(true);
    });

    test("returns false for legacy message key path", () => {
      expect(isEncodedWorkerQueueEntry("{org:o123}:message:run_abc123")).toBe(false);
    });
  });

  describe("encodeQueueMember / decodeQueueMember", () => {
    test("roundtrips correctly for PRODUCTION", () => {
      const original = {
        runId: "run_abc123xyz",
        workerQueue: "env_def456",
        attempt: 0,
        environmentType: "PRODUCTION" as const,
      };
      const encoded = encodeQueueMember(original);
      const decoded = decodeQueueMember(encoded);

      expect(decoded).toEqual(original);
    });

    test("roundtrips correctly for DEVELOPMENT", () => {
      const original = {
        runId: "run_test",
        workerQueue: "env_dev",
        attempt: 3,
        environmentType: "DEVELOPMENT" as const,
      };
      const encoded = encodeQueueMember(original);
      const decoded = decodeQueueMember(encoded);

      expect(decoded).toEqual(original);
    });

    test("roundtrips correctly for STAGING", () => {
      const original = {
        runId: "run_staging",
        workerQueue: "env_stage",
        attempt: 1,
        environmentType: "STAGING" as const,
      };
      const encoded = encodeQueueMember(original);
      const decoded = decodeQueueMember(encoded);

      expect(decoded).toEqual(original);
    });

    test("roundtrips correctly for PREVIEW", () => {
      const original = {
        runId: "run_preview",
        workerQueue: "env_preview",
        attempt: 5,
        environmentType: "PREVIEW" as const,
      };
      const encoded = encodeQueueMember(original);
      const decoded = decodeQueueMember(encoded);

      expect(decoded).toEqual(original);
    });

    test("decodeQueueMember returns undefined for legacy format", () => {
      expect(decodeQueueMember("run_abc123")).toBeUndefined();
    });

    test("decodeQueueMember returns undefined for malformed v3", () => {
      // Only 3 parts instead of 4
      expect(decodeQueueMember("run_abc\x1eenv_xyz\x1e0")).toBeUndefined();
    });
  });

  describe("encodeWorkerQueueEntry / decodeWorkerQueueEntry", () => {
    test("roundtrips correctly", () => {
      const original = {
        runId: "run_abc123xyz",
        workerQueue: "env_def456",
        attempt: 2,
        environmentType: "PRODUCTION" as const,
        queueKey: "{org:org123}:proj:proj456:env:env789:queue:my-task",
        timestamp: 1706812800000,
      };
      const encoded = encodeWorkerQueueEntry(original);
      const decoded = decodeWorkerQueueEntry(encoded);

      expect(decoded).toEqual(original);
    });

    test("roundtrips correctly with concurrency key in queue", () => {
      const original = {
        runId: "run_xyz",
        workerQueue: "env_abc",
        attempt: 0,
        environmentType: "DEVELOPMENT" as const,
        queueKey: "{org:o1}:proj:p1:env:e1:queue:task:ck:user-123",
        timestamp: 1706812800000,
      };
      const encoded = encodeWorkerQueueEntry(original);
      const decoded = decodeWorkerQueueEntry(encoded);

      expect(decoded).toEqual(original);
    });

    test("decodeWorkerQueueEntry returns undefined for legacy message key", () => {
      expect(decodeWorkerQueueEntry("{org:o123}:message:run_abc")).toBeUndefined();
    });
  });

  describe("getRunIdFromMember", () => {
    test("extracts runId from v3 encoded member", () => {
      const encoded = encodeQueueMember({
        runId: "run_abc123",
        workerQueue: "env_xyz",
        attempt: 0,
        environmentType: "PRODUCTION",
      });
      expect(getRunIdFromMember(encoded)).toBe("run_abc123");
    });

    test("returns legacy member as-is (it is the runId)", () => {
      expect(getRunIdFromMember("run_abc123")).toBe("run_abc123");
    });
  });

  describe("reconstructMessageFromWorkerEntry", () => {
    test("reconstructs full message payload", () => {
      const entry = {
        runId: "run_abc123",
        workerQueue: "env_xyz",
        attempt: 1,
        environmentType: "PRODUCTION" as const,
        queueKey: "{org:org123}:proj:proj456:env:env789:queue:my-task",
        timestamp: 1706812800000,
      };
      const descriptor = {
        orgId: "org123",
        projectId: "proj456",
        envId: "env789",
        queue: "my-task",
        concurrencyKey: undefined,
      };

      const message = reconstructMessageFromWorkerEntry(entry, descriptor);

      expect(message).toEqual({
        version: "2",
        runId: "run_abc123",
        taskIdentifier: "my-task",
        orgId: "org123",
        projectId: "proj456",
        environmentId: "env789",
        environmentType: "PRODUCTION",
        queue: "{org:org123}:proj:proj456:env:env789:queue:my-task",
        concurrencyKey: undefined,
        timestamp: 1706812800000,
        attempt: 1,
        workerQueue: "env_xyz",
      });
    });

    test("reconstructs message with concurrency key", () => {
      const entry = {
        runId: "run_xyz",
        workerQueue: "env_dev",
        attempt: 0,
        environmentType: "DEVELOPMENT" as const,
        queueKey: "{org:o1}:proj:p1:env:e1:queue:task:ck:user-42",
        timestamp: 1706812800000,
      };
      const descriptor = {
        orgId: "o1",
        projectId: "p1",
        envId: "e1",
        queue: "task",
        concurrencyKey: "user-42",
      };

      const message = reconstructMessageFromWorkerEntry(entry, descriptor);

      expect(message.concurrencyKey).toBe("user-42");
      expect(message.queue).toBe("{org:o1}:proj:p1:env:e1:queue:task:ck:user-42");
    });
  });

  describe("encoded size comparison", () => {
    test("v3 format is significantly smaller than full JSON", () => {
      const fullPayload = JSON.stringify({
        version: "2",
        runId: "run_clxyz123abc456def789",
        taskIdentifier: "my-background-task",
        orgId: "org_clxyz123abc456def789",
        projectId: "proj_clxyz123abc456def789",
        environmentId: "env_clxyz123abc456def789",
        environmentType: "PRODUCTION",
        queue: "{org:org_clxyz123abc456def789}:proj:proj_clxyz123abc456def789:env:env_clxyz123abc456def789:queue:my-background-task",
        concurrencyKey: undefined,
        timestamp: 1706812800000,
        attempt: 0,
        workerQueue: "env_clxyz123abc456def789",
      });

      const v3Encoded = encodeQueueMember({
        runId: "run_clxyz123abc456def789",
        workerQueue: "env_clxyz123abc456def789",
        attempt: 0,
        environmentType: "PRODUCTION",
      });

      // Full JSON is typically 400-600 bytes
      // v3 encoded queue member should be ~70-80 bytes
      expect(v3Encoded.length).toBeLessThan(fullPayload.length * 0.2);

      console.log(`Full JSON size: ${fullPayload.length} bytes`);
      console.log(`V3 encoded size: ${v3Encoded.length} bytes`);
      console.log(`Reduction: ${((1 - v3Encoded.length / fullPayload.length) * 100).toFixed(1)}%`);
    });
  });
});
