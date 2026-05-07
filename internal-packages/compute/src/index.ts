export { ComputeClient, ComputeClientError } from "./client.js";
export type { ComputeClientOptions } from "./client.js";
export { stripImageDigest } from "./imageRef.js";
export {
  MachineConfigSchema,
  TemplateCreateRequestSchema,
  TemplateCreateResultEntrySchema,
  TemplateCreateResponseSchema,
  InstanceCreateRequestSchema,
  InstanceCreateResponseSchema,
  InstanceSnapshotRequestSchema,
  SnapshotRestoreRequestSchema,
  SnapshotCallbackPayloadSchema,
} from "./types.js";
export type {
  MachineConfig,
  TemplateCreateRequest,
  TemplateCreateResultEntry,
  TemplateCreateResponse,
  InstanceCreateRequest,
  InstanceCreateResponse,
  InstanceSnapshotRequest,
  SnapshotRestoreRequest,
  SnapshotCallbackPayload,
} from "./types.js";
