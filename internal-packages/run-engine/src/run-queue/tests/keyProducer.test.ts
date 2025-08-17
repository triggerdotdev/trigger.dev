import { describe } from "node:test";
import { expect, it } from "vitest";
import { RunQueueFullKeyProducer } from "../keyProducer.js";

describe("KeyProducer", () => {
  it("queueConcurrencyLimitKey", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.queueConcurrencyLimitKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:concurrency");
  });

  it("envConcurrencyLimitKey", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.envConcurrencyLimitKey({
      id: "e1234",
      type: "PRODUCTION",
      project: { id: "p1234" },
      organization: { id: "o1234" },
    });
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:concurrency");
  });

  it("envConcurrencyLimitBurstFactorKey", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.envConcurrencyLimitBurstFactorKey({
      id: "e1234",
      type: "PRODUCTION",
      project: { id: "p1234" },
      organization: { id: "o1234" },
    });
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:concurrencyBurstFactor");
  });

  it("envCurrentDequeuedKey", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.envCurrentDequeuedKey({
      orgId: "o1234",
      projectId: "p1234",
      envId: "e1234",
    });

    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:currentDequeued");
  });

  it("queueKey (no concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name");
  });

  it("queueKey (w concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:ck:c1234");
  });

  it("queueConcurrencyLimitKeyFromQueue (w concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    const key = keyProducer.queueConcurrencyLimitKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:concurrency");
  });

  it("queueConcurrencyLimitKeyFromQueue (no concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.queueConcurrencyLimitKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:concurrency");
  });

  it("queueCurrentConcurrencyKeyFromQueue (w concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    const key = keyProducer.queueCurrentConcurrencyKeyFromQueue(queueKey);
    expect(key).toBe(
      "{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:ck:c1234:currentConcurrency"
    );
  });

  it("queueCurrentConcurrencyKeyFromQueue (no concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.queueCurrentConcurrencyKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:currentConcurrency");
  });

  it("queueCurrentConcurrencyKey (w concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.queueCurrentConcurrencyKey(
      {
        id: "e1234",
        type: "PRODUCTION",
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

  it("queueCurrentConcurrencyKey (no concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.queueCurrentConcurrencyKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );

    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:currentConcurrency");
  });

  it("queueCurrentDequeuedKeyFromQueue (w concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );

    const key = keyProducer.queueCurrentDequeuedKeyFromQueue(queueKey);
    expect(key).toBe(
      "{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:ck:c1234:currentDequeued"
    );
  });

  it("queueCurrentDequeuedKeyFromQueue (no concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.queueCurrentDequeuedKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:currentDequeued");
  });

  it("queueCurrentDequeuedKey (w concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.queueCurrentDequeuedKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    expect(key).toBe(
      "{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:ck:c1234:currentDequeued"
    );
  });

  it("queueCurrentDequeuedKey (no concurrency)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.queueCurrentDequeuedKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:queue:task/task-name:currentDequeued");
  });

  it("envConcurrencyLimitKeyFromQueue", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.envConcurrencyLimitKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:concurrency");
  });

  it("envConcurrencyLimitBurstFactorKeyFromQueue", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.envConcurrencyLimitBurstFactorKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:concurrencyBurstFactor");
  });

  it("envCurrentConcurrencyKeyFromQueue", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.envCurrentConcurrencyKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:currentConcurrency");
  });

  it("envCurrentDequeuedKeyFromQueue", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const key = keyProducer.envCurrentDequeuedKeyFromQueue(queueKey);
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:currentDequeued");
  });

  it("envCurrentConcurrencyKey", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.envCurrentConcurrencyKey({
      id: "e1234",
      type: "PRODUCTION",
      project: { id: "p1234" },
      organization: { id: "o1234" },
    });
    expect(key).toBe("{org:o1234}:proj:p1234:env:e1234:currentConcurrency");
  });

  it("messageKey", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const key = keyProducer.messageKey("o1234", "m1234");
    expect(key).toBe("{org:o1234}:message:m1234");
  });

  it("extractComponentsFromQueue (no concurrencyKey)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name"
    );
    const components = keyProducer.descriptorFromQueue(queueKey);
    expect(components).toEqual({
      orgId: "o1234",
      projectId: "p1234",
      envId: "e1234",
      queue: "task/task-name",
      concurrencyKey: undefined,
    });
  });

  it("extractComponentsFromQueue (w concurrencyKey)", () => {
    const keyProducer = new RunQueueFullKeyProducer();
    const queueKey = keyProducer.queueKey(
      {
        id: "e1234",
        type: "PRODUCTION",
        project: { id: "p1234" },
        organization: { id: "o1234" },
      },
      "task/task-name",
      "c1234"
    );
    const components = keyProducer.descriptorFromQueue(queueKey);
    expect(components).toEqual({
      orgId: "o1234",
      projectId: "p1234",
      envId: "e1234",
      queue: "task/task-name",
      concurrencyKey: "c1234",
    });
  });
});
