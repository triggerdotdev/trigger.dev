import { z } from "zod";

// ── Templates ────────────────────────────────────────────────────────────────

export const MachineConfigSchema = z.object({
  cpu: z.number(),
  memory_gb: z.number(),
});
export type MachineConfig = z.infer<typeof MachineConfigSchema>;

export const TemplateCreateRequestSchema = z.object({
  image: z.string(),
  machine_configs: z.array(MachineConfigSchema),
  background: z.boolean().optional(),
  callback: z
    .object({
      url: z.string(),
      metadata: z.record(z.string()).optional(),
    })
    .optional(),
});
export type TemplateCreateRequest = z.infer<typeof TemplateCreateRequestSchema>;

export const TemplateCreateResultEntrySchema = z.object({
  machine_config: MachineConfigSchema,
  error: z.string().optional(),
});
export type TemplateCreateResultEntry = z.infer<typeof TemplateCreateResultEntrySchema>;

export const TemplateCreateResponseSchema = z.object({
  results: z.array(TemplateCreateResultEntrySchema),
  error: z.string().optional(),
});
export type TemplateCreateResponse = z.infer<typeof TemplateCreateResponseSchema>;

// ── Instances ────────────────────────────────────────────────────────────────

export const InstanceCreateRequestSchema = z.object({
  name: z.string(),
  image: z.string(),
  env: z.record(z.string()),
  cpu: z.number(),
  memory_gb: z.number(),
  metadata: z.record(z.unknown()).optional(),
  // Per-VM endpoint labels applied to the VM's network endpoint for
  // network-policy selection. Distinct from metadata, which is
  // observability-only.
  network_labels: z.record(z.string()).optional(),
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
  // Per-VM endpoint labels applied to the restored endpoint for network-policy
  // selection. A restored VM must carry the same policy labels as a
  // freshly-booted one or its egress allows are lost.
  network_labels: z.record(z.string()).optional(),
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
