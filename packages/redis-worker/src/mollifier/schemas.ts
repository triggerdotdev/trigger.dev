import { z } from "zod";

export const BufferEntryStatus = z.enum(["QUEUED", "DRAINING", "FAILED"]);
export type BufferEntryStatus = z.infer<typeof BufferEntryStatus>;

export const BufferEntryError = z.object({
  code: z.string(),
  message: z.string(),
});
export type BufferEntryError = z.infer<typeof BufferEntryError>;

const stringToInt = z.string().transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected non-negative integer string" });
    return z.NEVER;
  }
  return n;
});

const stringToDate = z.string().transform((v, ctx) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected ISO date string" });
    return z.NEVER;
  }
  return d;
});

const stringToBool = z
  .union([z.literal("true"), z.literal("false")])
  .transform((v) => v === "true");

const stringToError = z.string().transform((v, ctx) => {
  try {
    return BufferEntryError.parse(JSON.parse(v));
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected JSON-encoded BufferEntryError" });
    return z.NEVER;
  }
});

export const BufferEntrySchema = z.object({
  runId: z.string().min(1),
  envId: z.string().min(1),
  orgId: z.string().min(1),
  payload: z.string(),
  status: BufferEntryStatus,
  attempts: stringToInt,
  createdAt: stringToDate,
  // Microsecond epoch matching the ZSET queue score. Stable across
  // requeues — the score never moves once set at accept time.
  createdAtMicros: stringToInt,
  // Drainer-ack flag: `true` once the drainer has materialised this run
  // into PG. The hash persists for a short grace TTL after ack so direct
  // reads (retrieve, trace, etc.) still resolve while PG replica lag
  // settles. Absent on pre-ack entries.
  materialised: stringToBool.default("false"),
  // Denormalised pointer to the Redis idempotency lookup key (set when
  // the run was accepted with an idempotency key, empty otherwise). The
  // ack Lua reads this to DEL the lookup atomically with marking the
  // entry materialised (Q5).
  idempotencyLookupKey: z.string().optional().default(""),
  // Optimistic-lock counter for the snapshot's `metadata` field.
  // Incremented atomically by the CAS metadata Lua. Matches the
  // semantic of `TaskRun.metadataVersion` on the PG side (which the
  // UpdateMetadataService uses for the same retry-on-conflict pattern).
  metadataVersion: stringToInt.default("0"),
  lastError: stringToError.optional(),
});

export type BufferEntry = z.infer<typeof BufferEntrySchema>;

export function serialiseSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot);
}

export function deserialiseSnapshot<T = unknown>(serialised: string): T {
  return JSON.parse(serialised) as T;
}
