import { IOPacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { env } from "~/env.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

export class MetadataTooLargeError extends ServiceValidationError {
  constructor(message: string) {
    super(message, 413);
    this.name = "MetadataTooLargeError";
  }
}

export function handleMetadataPacket(metadata: any, metadataType: string): IOPacket | undefined {
  let metadataPacket: IOPacket | undefined = undefined;

  if (typeof metadata === "string") {
    metadataPacket = { data: metadata, dataType: metadataType };
  }

  if (metadataType === "application/json") {
    metadataPacket = { data: JSON.stringify(metadata), dataType: "application/json" };
  }

  if (!metadataPacket || !metadataPacket.data) {
    return;
  }

  const byteLength = Buffer.byteLength(metadataPacket.data, "utf8");

  if (byteLength > env.TASK_RUN_METADATA_MAXIMUM_SIZE) {
    throw new MetadataTooLargeError(
      `Metadata exceeds maximum size of ${env.TASK_RUN_METADATA_MAXIMUM_SIZE} bytes`
    );
  }

  return metadataPacket;
}
