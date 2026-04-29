export { ComputeClient, ComputeClientError } from "./client.js";
export type { ComputeClientOptions } from "./client.js";
export { stripImageDigest } from "./imageRef.js";
export {
  TemplateCreateRequestSchema,
  TemplateCallbackPayloadSchema,
  InstanceCreateRequestSchema,
  InstanceCreateResponseSchema,
  InstanceSnapshotRequestSchema,
  SnapshotRestoreRequestSchema,
  SnapshotCallbackPayloadSchema,
} from "./types.js";
export type {
  TemplateCreateRequest,
  TemplateCallbackPayload,
  InstanceCreateRequest,
  InstanceCreateResponse,
  InstanceSnapshotRequest,
  SnapshotRestoreRequest,
  SnapshotCallbackPayload,
} from "./types.js";
