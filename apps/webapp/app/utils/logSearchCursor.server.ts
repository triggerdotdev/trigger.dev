import { z } from "zod";
import type { LogsSearchSlice } from "./logSearchSlices";

const LOG_CURSOR_VERSION = 6;

const LogsSearchKeysetSchema = z.object({
  triggeredTimestamp: z.string(),
  traceId: z.string(),
  spanId: z.string(),
  projectionFingerprint: z.string(),
});

const LogsSearchSliceSchema = z
  .object({
    anchorTime: z.number().int().nonnegative(),
    sliceFrom: z.number().int().nonnegative(),
    sliceTo: z.number().int().nonnegative(),
    upperInclusive: z.boolean(),
    remainingUpper: z.number().int().nonnegative(),
    pendingSliceFrom: z.number().int().nonnegative().optional(),
    keyset: LogsSearchKeysetSchema.optional(),
    rowsPerHour: z.number().nonnegative().optional(),
    sliceIndex: z.number().int().nonnegative(),
  })
  .refine(
    (slice) =>
      slice.sliceFrom <= slice.remainingUpper &&
      slice.remainingUpper <= slice.sliceTo &&
      slice.sliceTo <= slice.anchorTime &&
      (slice.pendingSliceFrom === undefined || slice.pendingSliceFrom <= slice.sliceFrom)
  );

export type LogCursor = {
  v: number;
  organizationId: string;
  environmentId: string;
  filterFingerprint: string;
  slice: LogsSearchSlice;
};

const LogCursorSchema = z.object({
  v: z.literal(LOG_CURSOR_VERSION),
  organizationId: z.string(),
  environmentId: z.string(),
  filterFingerprint: z.string(),
  slice: LogsSearchSliceSchema,
});

export function encodeLogsSearchCursor(
  organizationId: string,
  environmentId: string,
  filterFingerprint: string,
  slice: LogsSearchSlice
): string {
  return Buffer.from(
    JSON.stringify({
      v: LOG_CURSOR_VERSION,
      organizationId,
      environmentId,
      filterFingerprint,
      slice,
    } satisfies LogCursor)
  ).toString("base64");
}

export function decodeLogsSearchCursor(cursor: string): LogCursor | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const validated = LogCursorSchema.safeParse(JSON.parse(decoded));
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}
