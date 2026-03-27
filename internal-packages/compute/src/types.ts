import { z } from "zod";

// ── Templates ────────────────────────────────────────────────────────────────

export const TemplateCreateRequestSchema = z.object({
  image: z.string(),
  cpu: z.number(),
  memory_mb: z.number(),
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

export type InstanceCreateRequest = {
  name: string;
  image: string;
  env: Record<string, string>;
  cpu: number;
  memory_gb: number;
  metadata?: Record<string, unknown>;
};

export type InstanceCreateResponse = {
  id: string;
  _timing?: unknown;
};

export type InstanceSnapshotRequest = {
  callback: {
    url: string;
    metadata: Record<string, string>;
  };
};

// ── Snapshots ────────────────────────────────────────────────────────────────

export type SnapshotRestoreRequest = {
  name: string;
  metadata: Record<string, string>;
  cpu: number;
  memory_mb: number;
};
