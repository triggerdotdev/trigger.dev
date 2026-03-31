import { type IOPacket, packetRequiresOffloading, tryCatch } from "@trigger.dev/core/v3";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { env } from "~/env.server";
import { uploadPacketToObjectStore } from "~/v3/objectStore.server";
import { ServiceValidationError } from "~/v3/services/common.server";

function packetExtensionForDataType(dataType: string): string {
  switch (dataType) {
    case "application/json":
    case "application/super+json":
      return "json";
    case "text/plain":
      return "txt";
    default:
      return "txt";
  }
}

/**
 * Offloads large waitpoint completion payloads to object store (same threshold and
 * upload path pattern as DefaultPayloadProcessor). Object key prefix should use the
 * waitpoint friendly id folder, e.g. `${WaitpointId.toFriendlyId(internalId)}/token`.
 * Replaces no-op conditionallyExportPacket usage in webapp routes where apiClientManager is unset.
 */
export async function processWaitpointCompletionPacket(
  packet: IOPacket,
  environment: AuthenticatedEnvironment,
  pathPrefix: string
): Promise<IOPacket> {
  if (!packet.data) {
    return packet;
  }

  const { needsOffloading, size } = packetRequiresOffloading(
    packet,
    env.TASK_PAYLOAD_OFFLOAD_THRESHOLD
  );

  if (!needsOffloading) {
    return packet;
  }

  const filename = `${pathPrefix}.${packetExtensionForDataType(packet.dataType)}`;

  const [uploadError, uploadedFilename] = await tryCatch(
    uploadPacketToObjectStore(
      filename,
      packet.data,
      packet.dataType,
      environment,
      env.OBJECT_STORE_DEFAULT_PROTOCOL
    )
  );

  if (uploadError) {
    throw new ServiceValidationError("Failed to upload large waitpoint to object store", 500);
  }

  return {
    data: uploadedFilename!,
    dataType: "application/store",
  };
}
