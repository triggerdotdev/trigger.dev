import { expect, it } from "vitest";
import { z } from "zod";
import { redisTest } from "../test/containerTest.js";
import { describe } from "node:test";
import { RunQueueShortKeyProducer } from "./keyProducer.js";

describe("KeyProducer", () => {
  it("sharedQueueScanPattern", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const pattern = keyProducer.sharedQueueScanPattern();
    expect(pattern).toBe("test:*sharedQueue:main");
  });

  it("queueCurrentConcurrencyScanPattern", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const pattern = keyProducer.queueCurrentConcurrencyScanPattern();
    expect(pattern).toBe("test:{org:*}:proj:*:env:*:queue:*:currentConcurrency");
  });

  it("stripKeyPrefix", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.stripKeyPrefix("test:abc");
    expect(key).toBe("abc");
  });

  it("queueConcurrencyLimitKey", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.queueConcurrencyLimitKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:concurrency");
  });

  it("envConcurrencyLimitKey", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.envConcurrencyLimitKey({
      id: "e1234",
      type: "PRODUCTION",
      maximumConcurrencyLimit: 10,
      project: { id: "p1234" },
      organization: { id: "o1234" },
    });
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:concurrency");
  });

  it("queueKey (no concurrency)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name");
  });

  it("queueKey (w concurrency)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:ck:c1234");
  });

  it("envSharedQueueKey dev", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.envSharedQueueKey({
      id: "e1234",
      type: "DEVELOPMENT",
      maximumConcurrencyLimit: 10,
      project: { id: "p1234" },
      organization: { id: "o1234" },
    });
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:sharedQueue:main");
  });

  it("envSharedQueueKey deployed", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.envSharedQueueKey({
      id: "e1234",
      type: "PRODUCTION",
      maximumConcurrencyLimit: 10,
      project: { id: "p1234" },
      organization: { id: "o1234" },
    });
    expect(key).toBe("sharedQueue:main");
  });

  it("sharedQueueKey", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.sharedQueueKey();
    expect(key).toBe("sharedQueue:main");
  });

  it("concurrencyLimitKeyFromQueue (w concurrency)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    const key = keyProducer.concurrencyLimitKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:concurrency");
  });

  it("concurrencyLimitKeyFromQueue (no concurrency)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.concurrencyLimitKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:concurrency");
  });

  it("currentConcurrencyKeyFromQueue (w concurrency)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    const key = keyProducer.currentConcurrencyKeyFromQueue(queueKey);
    expect(key).toBe(
      "{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:ck:c1234:currentConcurrency"
    );
  });

  it("currentConcurrencyKeyFromQueue (no concurrency)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.currentConcurrencyKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:currentConcurrency");
  });

  it("currentConcurrencyKey (w concurrency)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.currentConcurrencyKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    expect(key).toBe(
      "{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:ck:c1234:currentConcurrency"
    );
  });

  it("currentConcurrencyKey (no concurrency)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.currentConcurrencyKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );

    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:currentConcurrency");
  });

  it("taskIdentifierCurrentConcurrencyKeyPrefixFromQueue", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.taskIdentifierCurrentConcurrencyKeyPrefixFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:task:");
  });

  it("taskIdentifierCurrentConcurrencyKeyFromQueue", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.taskIdentifierCurrentConcurrencyKeyFromQueue(queueKey, "task-name");
    expect(key).toBe("{org:o1234}:proj:p1234:task:task-name");
  });

  it("taskIdentifierCurrentConcurrencyKey", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.taskIdentifierCurrentConcurrencyKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task-name"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:task:task-name");
  });

  it("projectCurrentConcurrencyKey", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.projectCurrentConcurrencyKey({
      id: "e1234",
      type: "PRODUCTION",
      maximumConcurrencyLimit: 10,
      project: { id: "p1234" },
      organization: { id: "o1234" },
    });
    expect(key).toBe("{org:o1234}:proj:p1234:currentConcurrency");
  });

  it("projectCurrentConcurrencyKeyFromQueue", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.projectCurrentConcurrencyKeyFromQueue(
      "{org:o1234}:proj:p1234:currentConcurrency"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:currentConcurrency");
  });

  it("disabledConcurrencyLimitKeyFromQueue", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.disabledConcurrencyLimitKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:disabledConcurrency");
  });

  it("envConcurrencyLimitKeyFromQueue", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.envConcurrencyLimitKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:env:e1234:concurrency");
  });

  it("envCurrentConcurrencyKeyFromQueue", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.envCurrentConcurrencyKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:env:e1234:currentConcurrency");
  });

  it("envCurrentConcurrencyKey", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.envCurrentConcurrencyKey({
      id: "e1234",
      type: "PRODUCTION",
      maximumConcurrencyLimit: 10,
      project: { id: "p1234" },
      organization: { id: "o1234" },
    });
    expect(key).toBe("{org:o1234}:env:e1234:currentConcurrency");
  });

  it("messageKey", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const key = keyProducer.messageKey("o1234", "m1234");
    expect(key).toBe("{org:o1234}:message:m1234");
  });

  it("extractComponentsFromQueue (no concurrencyKey)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const components = keyProducer.extractComponentsFromQueue(queueKey);
    expect(components).toEqual({
      orgId: "o1234",
      projectId: "p1234",
      envId: "e1234",
      queue: "task/task-name",
      concurrencyKey: undefined,
    });
  });

  it("extractComponentsFromQueue (w concurrencyKey)", () => {
    const keyProducer = new RunQueueShortKeyProducer("test:", "main");
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        maximumConcurrencyLimit: 10,
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    const components = keyProducer.extractComponentsFromQueue(queueKey);
    expect(components).toEqual({
      orgId: "o1234",
      projectId: "p1234",
      envId: "e1234",
      queue: "task/task-name",
      concurrencyKey: "c1234",
    });
  });
});
