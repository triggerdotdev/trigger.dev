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
  lastError: stringToError.optional(),
});

export type BufferEntry = z.infer<typeof BufferEntrySchema>;

export function serialiseSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot);
}

export function deserialiseSnapshot<T = unknown>(serialised: string): T {
  return JSON.parse(serialised) as T;
}
