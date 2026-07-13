import type { IOPacket } from "@trigger.dev/core/v3";
import { packetRequiresOffloading, tryCatch } from "@trigger.dev/core/v3";
import type { PayloadProcessor, TriggerTaskRequest } from "../types";
import { env } from "~/env.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { uploadPacketToObjectStore } from "~/v3/objectStore.server";
import { ServiceValidationError } from "~/v3/services/common.server";

export class DefaultPayloadProcessor implements PayloadProcessor {
  async process(request: TriggerTaskRequest): Promise<IOPacket> {
    return await startActiveSpan("handlePayloadPacket()", async (span) => {
      const payload = request.body.payload;
      const payloadType = request.body.options?.payloadType ?? "application/json";

      const packet = this.#createPayloadPacket(payload, payloadType);

      if (!packet.data) {
        return packet;
      }

      const { needsOffloading, size } = packetRequiresOffloading(
        packet,
        env.TASK_PAYLOAD_OFFLOAD_THRESHOLD
      );

      span.setAttribute("needsOffloading", needsOffloading);
      // When the caller already offloaded the payload (payloadType "application/store"), the
      // packet here is just the small object-store reference, so `size` measures the reference,
      // not the payload. Prefer the caller-reported pre-offload size when it's provided so the
      // span reflects the real payload size. For inline payloads the two agree.
      span.setAttribute("size", request.body.options?.payloadSize ?? size);

      if (!needsOffloading) {
        return packet;
      }

      const filename = `${request.friendlyId}/payload.json`;

      const [uploadError, uploadedFilename] = await tryCatch(
        uploadPacketToObjectStore(
          filename,
          packet.data,
          packet.dataType,
          request.environment,
          env.OBJECT_STORE_DEFAULT_PROTOCOL
        )
      );

      if (uploadError) {
        throw new ServiceValidationError("Failed to upload large payload to object store", 500); // This is retryable
      }

      return {
        data: uploadedFilename!,
        dataType: "application/store",
      };
    });
  }

  #createPayloadPacket(payload: any, payloadType: string): IOPacket {
    if (payloadType === "application/json") {
      return { data: JSON.stringify(payload), dataType: "application/json" };
    }

    if (typeof payload === "string") {
      return { data: payload, dataType: payloadType };
    }

    return { dataType: payloadType };
  }
}
