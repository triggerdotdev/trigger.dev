import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { safeJsonParse } from "~/utils/json";
import type { TraceChunkCursor } from "./eventRepository.types";

// The cursor's start time is bound as a ClickHouse Int64; larger values would wrap around.
const MAX_INT64 = 9_223_372_036_854_775_807n;

const CursorPayload = z.object({
  t: z.string().refine((value) => /^\d+$/.test(value) && BigInt(value) <= MAX_INT64),
  s: z.string().min(1),
});

export function encodeTraceCursor(cursor: TraceChunkCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.startTime, s: cursor.spanId })).toString(
    "base64url"
  );
}

export function decodeTraceCursor(token: string): Result<TraceChunkCursor, "invalid_cursor"> {
  const payload = CursorPayload.safeParse(
    safeJsonParse(Buffer.from(token, "base64url").toString("utf-8"))
  );
  if (!payload.success) {
    return err("invalid_cursor");
  }

  return ok({ startTime: payload.data.t, spanId: payload.data.s });
}
