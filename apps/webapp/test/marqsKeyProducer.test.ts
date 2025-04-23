import { describe, it, expect } from "vitest";
import { MarQSShortKeyProducer } from "../app/v3/marqs/marqsKeyProducer.js";
import { MarQSKeyProducerEnv } from "~/v3/marqs/types.js";

describe("MarQSShortKeyProducer", () => {
  const prefix = "test:";
  const producer = new MarQSShortKeyProducer(prefix);

  // Sample test data
  const sampleEnv: MarQSKeyProducerEnv = {
    id: "123456789012345678901234",
    organizationId: "987654321098765432109876",
    type: "PRODUCTION",
  };

  const devEnv: MarQSKeyProducerEnv = {
    id: "123456789012345678901234",
    organizationId: "987654321098765432109876",
    type: "DEVELOPMENT",
  };

  describe("sharedQueueScanPattern", () => {
    it("should return correct shared queue scan pattern", () => {
      expect(producer.sharedQueueScanPattern()).toBe("test:*sharedQueue");
    });
  });

  describe("queueCurrentConcurrencyScanPattern", () => {
    it("should return correct queue current concurrency scan pattern", () => {
      expect(producer.queueCurrentConcurrencyScanPattern()).toBe(
        "test:org:*:env:*:queue:*:currentConcurrency"
      );
    });
  });

  describe("stripKeyPrefix", () => {
    it("should strip prefix from key if present", () => {
      expect(producer.stripKeyPrefix("test:someKey")).toBe("someKey");
    });

    it("should return original key if prefix not present", () => {
      expect(producer.stripKeyPrefix("someKey")).toBe("someKey");
    });
  });

  describe("queueKey", () => {
    it("should generate queue key with environment object", () => {
      expect(producer.queueKey(sampleEnv, "testQueue")).toBe(
        "org:765432109876:env:345678901234:queue:testQueue"
      );
    });

    it("should generate queue key with separate parameters", () => {
      expect(producer.queueKey("org123", "env456", "testQueue")).toBe(
        "org:org123:env:env456:queue:testQueue"
      );
    });

    it("should include concurrency key when provided", () => {
      expect(producer.queueKey(sampleEnv, "testQueue", "concKey")).toBe(
        "org:765432109876:env:345678901234:queue:testQueue:ck:concKey"
      );
    });
  });

  describe("queueKeyFromQueue", () => {
    it("should generate queue key", () => {
      expect(producer.queueKeyFromQueue("org:765432109876:env:345678901234:queue:testQueue")).toBe(
        "org:765432109876:env:345678901234:queue:testQueue"
      );
    });

    it("should include concurrency key when provided", () => {
      expect(
        producer.queueKeyFromQueue("org:765432109876:env:345678901234:queue:testQueue:ck:concKey")
      ).toBe("org:765432109876:env:345678901234:queue:testQueue:ck:concKey");
    });
  });

  describe("envSharedQueueKey", () => {
    it("should return organization-specific shared queue for development environment", () => {
      expect(producer.envSharedQueueKey(devEnv)).toBe(
        "org:765432109876:env:345678901234:sharedQueue"
      );
    });

    it("should return global shared queue for production environment", () => {
      expect(producer.envSharedQueueKey(sampleEnv)).toBe("sharedQueue");
    });
  });

  describe("queueDescriptorFromQueue", () => {
    it("should parse queue string into descriptor", () => {
      const queueString = "org:123:env:456:queue:testQueue:ck:concKey";
      const descriptor = producer.queueDescriptorFromQueue(queueString);

      expect(descriptor).toEqual({
        name: "testQueue",
        environment: "456",
        organization: "123",
        concurrencyKey: "concKey",
      });
    });

    it("should parse queue string without optional parameters", () => {
      const queueString = "org:123:env:456:queue:testQueue";
      const descriptor = producer.queueDescriptorFromQueue(queueString);

      expect(descriptor).toEqual({
        name: "testQueue",
        environment: "456",
        organization: "123",
        concurrencyKey: undefined,
      });
    });

    it("should throw error for invalid queue string", () => {
      const invalidQueue = "invalid:queue:string";
      expect(() => producer.queueDescriptorFromQueue(invalidQueue)).toThrow("Invalid queue");
    });
  });

  describe("messageKey", () => {
    it("should generate correct message key", () => {
      expect(producer.messageKey("msg123")).toBe("message:msg123");
    });
  });

  describe("nackCounterKey", () => {
    it("should generate correct nack counter key", () => {
      expect(producer.nackCounterKey("msg123")).toBe("message:msg123:nacks");
    });
  });

  describe("currentConcurrencyKey", () => {
    it("should generate correct current concurrency key", () => {
      expect(producer.queueCurrentConcurrencyKey(sampleEnv, "testQueue")).toBe(
        "org:765432109876:env:345678901234:queue:testQueue:currentConcurrency"
      );
    });

    it("should include concurrency key when provided", () => {
      expect(producer.queueCurrentConcurrencyKey(sampleEnv, "testQueue", "concKey")).toBe(
        "org:765432109876:env:345678901234:queue:testQueue:ck:concKey:currentConcurrency"
      );
    });
  });

  describe("currentConcurrencyKeyFromQueue", () => {
    it("should generate correct current concurrency key", () => {
      expect(
        producer.queueCurrentConcurrencyKeyFromQueue(
          "org:765432109876:env:345678901234:queue:testQueue"
        )
      ).toBe("org:765432109876:env:345678901234:queue:testQueue:currentConcurrency");
    });

    it("should include concurrency key when provided", () => {
      expect(
        producer.queueCurrentConcurrencyKeyFromQueue(
          "org:765432109876:env:345678901234:queue:testQueue:ck:concKey"
        )
      ).toBe("org:765432109876:env:345678901234:queue:testQueue:ck:concKey:currentConcurrency");
    });
  });

  describe("queueReserveConcurrencyKeyFromQueue", () => {
    it("should generate correct queue reserve concurrency key", () => {
      expect(
        producer.queueReserveConcurrencyKeyFromQueue(
          "org:765432109876:env:345678901234:queue:testQueue"
        )
      ).toBe("org:765432109876:env:345678901234:queue:testQueue:reserveConcurrency");
    });

    it("should NOT include the concurrency key when provided", () => {
      expect(
        producer.queueReserveConcurrencyKeyFromQueue(
          "org:765432109876:env:345678901234:queue:testQueue:ck:concKey"
        )
      ).toBe("org:765432109876:env:345678901234:queue:testQueue:reserveConcurrency");
    });
  });

  describe("queueConcurrencyLimitKeyFromQueue", () => {
    it("should generate correct queue concurrency limit key", () => {
      expect(
        producer.queueConcurrencyLimitKeyFromQueue(
          "org:765432109876:env:345678901234:queue:testQueue"
        )
      ).toBe("org:765432109876:env:345678901234:queue:testQueue:concurrency");
    });

    it("should NOT include the concurrency key when provided", () => {
      expect(
        producer.queueConcurrencyLimitKeyFromQueue(
          "org:765432109876:env:345678901234:queue:testQueue:ck:concKey"
        )
      ).toBe("org:765432109876:env:345678901234:queue:testQueue:concurrency");
    });
  });

  describe("envCurrentConcurrencyKey", () => {
    it("should generate correct env current concurrency key with environment object", () => {
      expect(producer.envCurrentConcurrencyKey(sampleEnv)).toBe(
        "env:345678901234:currentConcurrency"
      );
    });

    it("should generate correct env current concurrency key with env id", () => {
      expect(producer.envCurrentConcurrencyKey("env456")).toBe("env:env456:currentConcurrency");
    });
  });

  describe("orgIdFromQueue and envIdFromQueue", () => {
    it("should extract org id from queue string", () => {
      const queue = "org:123:env:456:queue:testQueue";
      expect(producer.orgIdFromQueue(queue)).toBe("123");
    });

    it("should extract env id from queue string", () => {
      const queue = "org:123:env:456:queue:testQueue";
      expect(producer.envIdFromQueue(queue)).toBe("456");
    });
  });
});
