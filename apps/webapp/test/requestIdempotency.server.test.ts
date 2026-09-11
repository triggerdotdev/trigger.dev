import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RequestIdempotencyService } from "~/services/requestIdempotency.server";
import {
  scopeRequestIdempotencyHeader,
  scopeRequestIdempotencyKey,
} from "~/utils/requestIdempotencyKey";

function createService() {
  return new RequestIdempotencyService({ types: ["trigger", "batch-trigger"] });
}

describe("RequestIdempotencyService", () => {
  it("returns the saved entry for a scoped key", async () => {
    const service = createService();
    const scopedKey = scopeRequestIdempotencyHeader(randomUUID(), ["env-1", "task-a"]);

    expect(scopedKey).toBeDefined();

    await service.saveRequest("trigger", scopedKey!, { id: "run_1234" });

    await expect(service.checkRequest("trigger", scopedKey!)).resolves.toEqual({ id: "run_1234" });
  });

  it("keeps entries isolated by environment, task and request type", async () => {
    const service = createService();
    const requestIdempotencyKey = randomUUID();
    const scopedKey = scopeRequestIdempotencyHeader(requestIdempotencyKey, ["env-1", "task-a"]);

    await service.saveRequest("trigger", scopedKey!, { id: "run_1234" });

    const otherEnvironment = scopeRequestIdempotencyHeader(requestIdempotencyKey, [
      "env-2",
      "task-a",
    ]);
    const otherTask = scopeRequestIdempotencyHeader(requestIdempotencyKey, ["env-1", "task-b"]);

    await expect(service.checkRequest("trigger", otherEnvironment!)).resolves.toBeUndefined();
    await expect(service.checkRequest("trigger", otherTask!)).resolves.toBeUndefined();
    await expect(service.checkRequest("batch-trigger", scopedKey!)).resolves.toBeUndefined();
  });

  it("accepts a scoped body key, not just a scoped header", async () => {
    const service = createService();
    const scopedKey = scopeRequestIdempotencyKey("my-batch-key", ["env-1", "task-a"]);

    await service.saveRequest("batch-trigger", scopedKey!, { id: "batch_1234" });

    await expect(service.checkRequest("batch-trigger", scopedKey!)).resolves.toEqual({
      id: "batch_1234",
    });
  });

  it("ignores a key that was not scoped, instead of throwing", async () => {
    const service = createService();
    const unscopedKey = randomUUID();

    await expect(
      service.saveRequest("trigger", unscopedKey, { id: "run_1234" })
    ).resolves.toBeUndefined();
    await expect(service.checkRequest("trigger", unscopedKey)).resolves.toBeUndefined();
  });
});
