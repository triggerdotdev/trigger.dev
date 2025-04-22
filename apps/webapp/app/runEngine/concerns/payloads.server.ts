import { IOPacket, packetRequiresOffloading, tryCatch } from "@trigger.dev/core/v3";
import { PayloadProcessor, TriggerTaskRequest } from "../types";
import { env } from "~/env.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { uploadPacketToObjectStore } from "~/v3/r2.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

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
      span.setAttribute("size", size);

      if (!needsOffloading) {
        return packet;
      }

      const filename = `${request.friendlyId}/payload.json`;

      const [uploadError] = await tryCatch(
        uploadPacketToObjectStore(filename, packet.data, packet.dataType, request.environment)
      );

      if (uploadError) {
        throw new ServiceValidationError("Failed to upload large payload to object store", 500); // This is retryable
      }

      return {
        data: filename,
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
