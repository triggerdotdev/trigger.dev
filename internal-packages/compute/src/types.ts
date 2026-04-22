import { z } from "zod";

// ── Templates ────────────────────────────────────────────────────────────────

export const TemplateCreateRequestSchema = z.object({
  image: z.string(),
  cpu: z.number(),
  memory_gb: z.number(),
  background: z.boolean().optional(),
  callback: z
    .object({
      url: z.string(),
      metadata: z.record(z.string()).optional(),
    })
    .optional(),
});
export type TemplateCreateRequest = z.infer<typeof TemplateCreateRequestSchema>;

export const TemplateCallbackPayloadSchema = z.object({
  template_id: z.string().optional(),
  image: z.string(),
  status: z.enum(["completed", "failed"]),
  error: z.string().optional(),
  metadata: z.record(z.string()).optional(),
  duration_ms: z.number().optional(),
});
export type TemplateCallbackPayload = z.infer<typeof TemplateCallbackPayloadSchema>;

// ── Instances ────────────────────────────────────────────────────────────────

export const InstanceCreateRequestSchema = z.object({
  name: z.string(),
  image: z.string(),
  env: z.record(z.string()),
  cpu: z.number(),
  memory_gb: z.number(),
  metadata: z.record(z.unknown()).optional(),
});
export type InstanceCreateRequest = z.infer<typeof InstanceCreateRequestSchema>;

export const InstanceCreateResponseSchema = z.object({
  id: z.string(),
  _timing: z.unknown().optional(),
});
export type InstanceCreateResponse = z.infer<typeof InstanceCreateResponseSchema>;

export const InstanceSnapshotRequestSchema = z.object({
  callback: z.object({
    url: z.string(),
    metadata: z.record(z.string()),
  }),
});
export type InstanceSnapshotRequest = z.infer<typeof InstanceSnapshotRequestSchema>;

// ── Snapshots ────────────────────────────────────────────────────────────────

export const SnapshotRestoreRequestSchema = z.object({
  name: z.string(),
  metadata: z.record(z.string()),
  cpu: z.number(),
  memory_gb: z.number(),
});
export type SnapshotRestoreRequest = z.infer<typeof SnapshotRestoreRequestSchema>;

export const SnapshotCallbackPayloadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    snapshot_id: z.string(),
    instance_id: z.string(),
    metadata: z.record(z.string()).optional(),
    duration_ms: z.number().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    instance_id: z.string(),
    error: z.string().optional(),
    metadata: z.record(z.string()).optional(),
    duration_ms: z.number().optional(),
  }),
]);
export type SnapshotCallbackPayload = z.infer<typeof SnapshotCallbackPayloadSchema>;
