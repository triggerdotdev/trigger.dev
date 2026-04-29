import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks (must come before imports) ---

vi.mock("~/v3/objectStore.server", () => ({
  hasObjectStoreClient: vi.fn().mockReturnValue(true),
  uploadPacketToObjectStore: vi.fn(),
}));

// Threshold of 10 bytes so any non-trivial payload triggers offloading
vi.mock("~/env.server", () => ({
  env: {
    BATCH_PAYLOAD_OFFLOAD_THRESHOLD: 10,
    TASK_PAYLOAD_OFFLOAD_THRESHOLD: 10,
    OBJECT_STORE_DEFAULT_PROTOCOL: undefined,
  },
}));

// Execute the span callback synchronously without real OTel
vi.mock("~/v3/tracer.server", () => ({
  startActiveSpan: vi.fn(async (_name: string, fn: (span: any) => any) =>
    fn({ setAttribute: vi.fn() })
  ),
}));

import { BatchPayloadProcessor } from "../../app/runEngine/concerns/batchPayloads.server";
import * as objectStore from "~/v3/objectStore.server";

vi.setConfig({ testTimeout: 30_000 });

// Minimal AuthenticatedEnvironment shape required by BatchPayloadProcessor
const mockEnvironment = {
  id: "env-test",
  slug: "production",
  project: { externalRef: "proj-ext-ref" },
} as any;

describe("BatchPayloadProcessor", () => {
  let mockUpload: ReturnType<typeof vi.mocked<typeof objectStore.uploadPacketToObjectStore>>;

  beforeEach(() => {
    mockUpload = vi.mocked(objectStore.uploadPacketToObjectStore);
    mockUpload.mockReset();
  });

  it("offloads a large payload successfully on first attempt", async () => {
    mockUpload.mockResolvedValueOnce("batch_abc/item_0/payload.json");

    const processor = new BatchPayloadProcessor();
    const result = await processor.process(
      '{"message":"hello world"}',
      "application/json",
      "batch-internal-abc",
      0,
      mockEnvironment
    );

    expect(result.wasOffloaded).toBe(true);
    expect(result.payloadType).toBe("application/store");
    expect(result.payload).toBe("batch_abc/item_0/payload.json");
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it("retries on transient fetch failure and succeeds on third attempt", async () => {
    mockUpload
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce("batch_abc/item_0/payload.json");

    const processor = new BatchPayloadProcessor();
    const result = await processor.process(
      '{"message":"hello world"}',
      "application/json",
      "batch-internal-abc",
      0,
      mockEnvironment
    );

    expect(result.wasOffloaded).toBe(true);
    expect(mockUpload).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all retry attempts", async () => {
    mockUpload.mockRejectedValue(new Error("fetch failed"));

    const processor = new BatchPayloadProcessor();

    await expect(
      processor.process(
        '{"message":"hello world"}',
        "application/json",
        "batch-internal-abc",
        0,
        mockEnvironment
      )
    ).rejects.toThrow("Failed to upload large payload to object store: fetch failed");

    // 1 initial attempt + 3 retries = 4 total calls
    expect(mockUpload).toHaveBeenCalledTimes(4);
  });

  it("does not offload when there is no payload data", async () => {
    const processor = new BatchPayloadProcessor();
    const result = await processor.process(
      undefined,
      "application/json",
      "batch-internal-abc",
      0,
      mockEnvironment
    );

    expect(result.wasOffloaded).toBe(false);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
