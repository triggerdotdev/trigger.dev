import { describe, expect, it } from "vitest";
import { BatchQueueFullKeyProducer } from "../keyProducer.js";

describe("BatchQueueKeyProducer", () => {
  const keyProducer = new BatchQueueFullKeyProducer();

  describe("masterQueueKey", () => {
    it("should generate the master queue key", () => {
      const key = keyProducer.masterQueueKey();
      expect(key).toBe("batch:master");
    });
  });

  describe("deficitHashKey", () => {
    it("should generate the deficit hash key", () => {
      const key = keyProducer.deficitHashKey();
      expect(key).toBe("batch:deficit");
    });
  });

  describe("batchQueueKey", () => {
    it("should generate batch queue key", () => {
      const key = keyProducer.batchQueueKey("batch123");
      expect(key).toBe("batch:batch123:queue");
    });
  });

  describe("batchItemsKey", () => {
    it("should generate batch items key", () => {
      const key = keyProducer.batchItemsKey("batch123");
      expect(key).toBe("batch:batch123:items");
    });
  });

  describe("batchMetaKey", () => {
    it("should generate batch metadata key", () => {
      const key = keyProducer.batchMetaKey("batch123");
      expect(key).toBe("batch:batch123:meta");
    });
  });

  describe("batchRunsKey", () => {
    it("should generate batch runs key", () => {
      const key = keyProducer.batchRunsKey("batch123");
      expect(key).toBe("batch:batch123:runs");
    });
  });

  describe("batchFailuresKey", () => {
    it("should generate batch failures key", () => {
      const key = keyProducer.batchFailuresKey("batch123");
      expect(key).toBe("batch:batch123:failures");
    });
  });

  describe("masterQueueMember", () => {
    it("should create master queue member from envId and batchId", () => {
      const member = keyProducer.masterQueueMember("env123", "batch456");
      expect(member).toBe("env123:batch456");
    });

    it("should handle complex IDs", () => {
      const member = keyProducer.masterQueueMember("env-prod-123", "batch_abc_xyz");
      expect(member).toBe("env-prod-123:batch_abc_xyz");
    });
  });

  describe("parseMasterQueueMember", () => {
    it("should parse master queue member to extract envId and batchId", () => {
      const result = keyProducer.parseMasterQueueMember("env123:batch456");
      expect(result.envId).toBe("env123");
      expect(result.batchId).toBe("batch456");
    });

    it("should handle complex IDs", () => {
      const result = keyProducer.parseMasterQueueMember("env-prod-123:batch_abc_xyz");
      expect(result.envId).toBe("env-prod-123");
      expect(result.batchId).toBe("batch_abc_xyz");
    });

    it("should handle batchId with colons", () => {
      // batchId might contain colons, so we only split on the first colon
      const result = keyProducer.parseMasterQueueMember("env123:batch:with:colons");
      expect(result.envId).toBe("env123");
      expect(result.batchId).toBe("batch:with:colons");
    });

    it("should throw for invalid member format", () => {
      expect(() => keyProducer.parseMasterQueueMember("invalid")).toThrow(
        "Invalid master queue member format"
      );
    });
  });

  describe("batchIdFromKey", () => {
    it("should extract batch ID from batch queue key", () => {
      const batchId = keyProducer.batchIdFromKey("batch:mybatch123:queue");
      expect(batchId).toBe("mybatch123");
    });

    it("should extract batch ID from batch items key", () => {
      const batchId = keyProducer.batchIdFromKey("batch:mybatch123:items");
      expect(batchId).toBe("mybatch123");
    });

    it("should extract batch ID from batch meta key", () => {
      const batchId = keyProducer.batchIdFromKey("batch:mybatch123:meta");
      expect(batchId).toBe("mybatch123");
    });

    it("should handle complex batch IDs", () => {
      const batchId = keyProducer.batchIdFromKey("batch:batch_abc123xyz:queue");
      expect(batchId).toBe("batch_abc123xyz");
    });

    it("should throw for key with only one part", () => {
      expect(() => keyProducer.batchIdFromKey("invalid")).toThrow("Invalid batch key format");
    });

    it("should throw for key with wrong prefix", () => {
      expect(() => keyProducer.batchIdFromKey("other:batch123:queue")).toThrow(
        "Invalid batch key format"
      );
    });
  });

  describe("key uniqueness", () => {
    it("should generate unique keys for different batches", () => {
      const keys = [
        keyProducer.batchQueueKey("batch1"),
        keyProducer.batchQueueKey("batch2"),
        keyProducer.batchItemsKey("batch1"),
        keyProducer.batchMetaKey("batch1"),
        keyProducer.batchRunsKey("batch1"),
        keyProducer.batchFailuresKey("batch1"),
      ];

      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it("should generate unique global keys", () => {
      const keys = [keyProducer.masterQueueKey(), keyProducer.deficitHashKey()];

      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it("should generate unique master queue members", () => {
      const members = [
        keyProducer.masterQueueMember("env1", "batch1"),
        keyProducer.masterQueueMember("env1", "batch2"),
        keyProducer.masterQueueMember("env2", "batch1"),
      ];

      const uniqueMembers = new Set(members);
      expect(uniqueMembers.size).toBe(members.length);
    });
  });
});
