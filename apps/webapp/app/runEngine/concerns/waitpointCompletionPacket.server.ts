import { type IOPacket, packetRequiresOffloading, tryCatch } from "@trigger.dev/core/v3";
import { parseWaitpointId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { MAX_INLINE_COMPLETION_OUTPUT_BYTES } from "@internal/run-engine";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { env } from "~/env.server";
import { uploadPacketToObjectStore } from "~/v3/objectStore.server";
import { logger } from "~/services/logger.server";
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
  pathPrefix: string,
  maximumInlineSize?: number
): Promise<IOPacket> {
  if (!packet.data) {
    return packet;
  }

  const { needsOffloading, size: _size } = packetRequiresOffloading(
    packet,
    maximumInlineSize === undefined
      ? env.TASK_PAYLOAD_OFFLOAD_THRESHOLD
      : Math.min(env.TASK_PAYLOAD_OFFLOAD_THRESHOLD, maximumInlineSize)
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
    logger.error("Failed to upload large waitpoint to object store", {
      error: uploadError,
      filename,
      environmentId: environment.id,
    });
    throw new ServiceValidationError("Failed to upload large waitpoint to object store", 500);
  }

  return {
    data: uploadedFilename!,
    dataType: "application/store",
  };
}

/** Native stream tokens need bounded output; legacy tokens retain their inline packet. */
export async function processStreamWaitpointCompletionPacket(
  waitpointId: string,
  data: string,
  environment: AuthenticatedEnvironment
): Promise<IOPacket> {
  const packet = { data, dataType: "application/json" };
  const parsed = parseWaitpointId(waitpointId);
  if (parsed.format === "legacy" || (parsed.type !== "DATETIME" && parsed.type !== "MANUAL")) {
    return packet;
  }

  // A later/competing send must never overwrite the object referenced by the winning completion.
  return processWaitpointCompletionPacket(
    packet,
    environment,
    `${WaitpointId.toFriendlyId(waitpointId)}/stream/${crypto.randomUUID()}`,
    MAX_INLINE_COMPLETION_OUTPUT_BYTES
  );
}
