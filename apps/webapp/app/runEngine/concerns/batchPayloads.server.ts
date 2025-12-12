import { IOPacket, packetRequiresOffloading, tryCatch } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { uploadPacketToObjectStore, r2 } from "~/v3/r2.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

export type BatchPayloadProcessResult = {
  /** The processed payload - either the original or an R2 path */
  payload: unknown;
  /** The payload type - "application/store" if offloaded to R2 */
  payloadType: string;
  /** Whether the payload was offloaded to R2 */
  wasOffloaded: boolean;
  /** Size of the payload in bytes */
  size: number;
};

/**
 * BatchPayloadProcessor handles payload offloading for batch items.
 *
 * When a batch item's payload exceeds the configured threshold, it's uploaded
 * to object storage (R2) and the payload is replaced with the storage path.
 * This aligns with how single task triggers work via DefaultPayloadProcessor.
 *
 * Path format: batch_{batchId}/item_{index}/payload.json
 */
export class BatchPayloadProcessor {
  /**
   * Check if object storage is available for payload offloading.
   * If not available, large payloads will be stored inline (which may fail for very large payloads).
   */
  isObjectStoreAvailable(): boolean {
    return r2 !== undefined && env.OBJECT_STORE_BASE_URL !== undefined;
  }

  /**
   * Process a batch item payload, offloading to R2 if it exceeds the threshold.
   *
   * @param payload - The raw payload from the batch item
   * @param payloadType - The payload type (e.g., "application/json")
   * @param batchId - The batch ID (internal format)
   * @param itemIndex - The item index within the batch
   * @param environment - The authenticated environment for R2 path construction
   * @returns The processed result with potentially offloaded payload
   */
  async process(
    payload: unknown,
    payloadType: string,
    batchId: string,
    itemIndex: number,
    environment: AuthenticatedEnvironment
  ): Promise<BatchPayloadProcessResult> {
    return startActiveSpan("BatchPayloadProcessor.process()", async (span) => {
      span.setAttribute("batchId", batchId);
      span.setAttribute("itemIndex", itemIndex);
      span.setAttribute("payloadType", payloadType);

      // Create the packet for size checking
      const packet = this.#createPayloadPacket(payload, payloadType);

      if (!packet.data) {
        return {
          payload,
          payloadType,
          wasOffloaded: false,
          size: 0,
        };
      }

      const threshold = env.BATCH_PAYLOAD_OFFLOAD_THRESHOLD ?? env.TASK_PAYLOAD_OFFLOAD_THRESHOLD;
      const { needsOffloading, size } = packetRequiresOffloading(packet, threshold);

      span.setAttribute("payloadSize", size);
      span.setAttribute("needsOffloading", needsOffloading);
      span.setAttribute("threshold", threshold);

      if (!needsOffloading) {
        return {
          payload,
          payloadType,
          wasOffloaded: false,
          size,
        };
      }

      // Check if object store is available
      if (!this.isObjectStoreAvailable()) {
        logger.warn("Payload exceeds threshold but object store is not available", {
          batchId,
          itemIndex,
          size,
          threshold,
        });

        // Return without offloading - the payload will be stored inline
        // This may fail downstream for very large payloads
        return {
          payload,
          payloadType,
          wasOffloaded: false,
          size,
        };
      }

      // Upload to R2
      const filename = `batch_${batchId}/item_${itemIndex}/payload.json`;

      const [uploadError] = await tryCatch(
        uploadPacketToObjectStore(filename, packet.data, packet.dataType, environment)
      );

      if (uploadError) {
        logger.error("Failed to upload batch item payload to object store", {
          batchId,
          itemIndex,
          error: uploadError instanceof Error ? uploadError.message : String(uploadError),
        });

        // Throw to fail this item - SDK can retry
        throw new Error(
          `Failed to upload large payload to object store: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`
        );
      }

      logger.debug("Batch item payload offloaded to R2", {
        batchId,
        itemIndex,
        filename,
        size,
      });

      span.setAttribute("wasOffloaded", true);
      span.setAttribute("offloadPath", filename);

      return {
        payload: filename,
        payloadType: "application/store",
        wasOffloaded: true,
        size,
      };
    });
  }

  /**
   * Create an IOPacket from payload for size checking.
   */
  #createPayloadPacket(payload: unknown, payloadType: string): IOPacket {
    if (payloadType === "application/json") {
      return { data: JSON.stringify(payload), dataType: "application/json" };
    }

    if (typeof payload === "string") {
      return { data: payload, dataType: payloadType };
    }

    // For other types, try to stringify
    try {
      return { data: JSON.stringify(payload), dataType: payloadType };
    } catch {
      return { dataType: payloadType };
    }
  }
}

