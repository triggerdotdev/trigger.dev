import type { RetrieveRunTracePageResponseBody } from "@trigger.dev/core/v3";
import { tryCatch } from "@trigger.dev/core/utils";
import type { TaskRunStatus } from "@trigger.dev/database";
import { err, ok, type Result } from "neverthrow";
import { logger } from "~/services/logger.server";
import type { IEventRepository } from "./eventRepository.types";
import { encodeTraceCursor } from "./traceCursor";
import { getTraceInsertedAtEnd } from "./traceInsertedAtBound";
import { buildTracePage } from "./tracePage";
import type { TracePageRequest } from "./tracePageRequest";
import type { TaskEventStoreTable } from "../taskEventStore.server";

export type RunTracePageError = "store_unavailable" | "paging_unsupported";

export type RunTracePageRun = {
  traceId: string;
  status: TaskRunStatus;
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
};

export async function getRunTracePage({
  repository,
  storeTable,
  environmentId,
  run,
  pageRequest,
  stopAfterPage = false,
}: {
  repository: IEventRepository;
  storeTable: TaskEventStoreTable;
  environmentId: string;
  run: RunTracePageRun;
  pageRequest: TracePageRequest;
  /** Under the emergency span cap: serve this page but don't offer a next one. */
  stopAfterPage?: boolean;
}): Promise<Result<RetrieveRunTracePageResponseBody, RunTracePageError>> {
  const [chunkError, chunk] = await tryCatch(
    repository.getTraceChunk(
      storeTable,
      environmentId,
      run.traceId,
      run.createdAt,
      run.completedAt ?? undefined,
      pageRequest.after,
      { limit: pageRequest.limit, insertedAtEnd: getTraceInsertedAtEnd(run) }
    )
  );

  if (chunkError) {
    logger.error("Failed to read a trace page", {
      traceId: run.traceId,
      environmentId,
      error: chunkError,
    });
    return err("store_unavailable");
  }

  if (!chunk) {
    return err("paging_unsupported");
  }

  const { spans, attemptFailures } = buildTracePage(chunk.events);
  if (stopAfterPage && chunk.hasMore) {
    return ok({ data: spans, attemptFailures, pagination: { truncated: true } });
  }

  const next = chunk.hasMore && chunk.nextCursor ? encodeTraceCursor(chunk.nextCursor) : undefined;
  if (chunk.droppedKeyRows) {
    return ok({
      data: spans,
      attemptFailures,
      pagination: { ...(next ? { next } : {}), truncated: true },
    });
  }

  return ok({ data: spans, attemptFailures, pagination: next ? { next } : {} });
}
