import { err, ok, type Result } from "neverthrow";
import type { TraceChunkCursor } from "./eventRepository.types";
import { decodeTraceCursor } from "./traceCursor";

// Each page re-reads the trace from the cursor onward, so small pages multiply ClickHouse reads.
export const MIN_TRACE_PAGE_SIZE = 1_000;
export const MAX_TRACE_PAGE_SIZE = 10_000;
export const DEFAULT_TRACE_PAGE_SIZE = MAX_TRACE_PAGE_SIZE;

export type TracePageRequest = {
  limit: number;
  after: TraceChunkCursor | undefined;
};

export type TracePageRequestError = "invalid_page_size" | "invalid_cursor";

/** `null` when the request has no page parameters, i.e. wants the unpaged tree. */
export function parseTracePageRequest(
  searchParams: URLSearchParams,
  defaultSize: number
): Result<TracePageRequest | null, TracePageRequestError> {
  const size = searchParams.get("page[size]");
  const after = searchParams.get("page[after]");

  if (size === null && after === null) {
    return ok(null);
  }

  let limit = defaultSize;
  if (size !== null) {
    if (!/^\d+$/.test(size) || Number(size) < 1) {
      return err("invalid_page_size");
    }
    limit = Number(size);
  }

  let cursor: TraceChunkCursor | undefined;
  if (after !== null) {
    const decoded = decodeTraceCursor(after);
    if (decoded.isErr()) {
      return err(decoded.error);
    }
    cursor = decoded.value;
  }

  return ok({
    limit: Math.min(Math.max(limit, MIN_TRACE_PAGE_SIZE), MAX_TRACE_PAGE_SIZE),
    after: cursor,
  });
}
