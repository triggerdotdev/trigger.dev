import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { runStore } from "~/v3/runStore.server";
import { requireUser } from "~/services/session.server";
import { v3RunParamsSchema, v3RunPath } from "~/utils/pathBuilder";
import { createGzip } from "zlib";
import { Readable } from "stream";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import {
  getTraceExportFormat,
  streamTraceExport,
  type TraceExportContext,
} from "~/v3/eventRepository/traceExport.server";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const parsedParams = v3RunParamsSchema.pick({ runParam: true }).parse(params);

  const url = new URL(request.url);
  // ?format=log|jsonl|markdown (default log). ?showDebug=true includes internal
  // engine debug events; these stay admin-only (matching the admin-gated Debug
  // toggle in the trace view) and are off by default.
  const format = getTraceExportFormat(url.searchParams.get("format"));
  const showDebug = url.searchParams.get("showDebug") === "true" && user.admin;
  const filename = `${parsedParams.runParam}.${format.extension}`;

  const run = await runStore.findRun(
    {
      friendlyId: parsedParams.runParam,
      project: {
        organization: {
          members: {
            some: {
              userId: user.id,
            },
          },
        },
      },
    },
    {
      select: {
        friendlyId: true,
        traceId: true,
        organizationId: true,
        runtimeEnvironmentId: true,
        createdAt: true,
        completedAt: true,
        taskEventStore: true,
        taskIdentifier: true,
        project: { select: { slug: true, organization: { select: { slug: true } } } },
        runtimeEnvironment: { select: { slug: true } },
      },
    },
    prisma
  );

  if (!run || !run.organizationId) {
    // Buffered run? It hasn't executed, so there's no trace to stream — but a
    // 404 is wrong: the run does exist, the customer's "Download trace" button
    // on the run-detail page generates this exact URL, and a 404 reads as "your
    // run vanished" rather than "no trace yet". Verify the entry exists in the
    // buffer (with the user as a member of the entry's org), and if so stream a
    // single informational line instead of a 0-byte mystery.
    const buffer = getMollifierBuffer();
    if (buffer) {
      const entry = await buffer.getEntry(parsedParams.runParam);
      if (entry) {
        const member = await prisma.orgMember.findFirst({
          where: { userId: user.id, organizationId: entry.orgId },
          select: { id: true },
        });
        if (member) {
          return streamGzipText(
            `Run ${parsedParams.runParam} is queued and has not started executing yet — no trace to download.\n`,
            filename
          );
        }
      }
    }
    return new Response("Not found", { status: 404 });
  }

  const eventRepository = await getEventRepositoryForStore(run.taskEventStore, run.organizationId);

  // Stream the trace straight from the store to the gzip response, one event at
  // a time, never materialising the full set or building a tree. This keeps the
  // download bounded in memory and non-blocking regardless of how large the
  // trace is. The chosen format renders each event as it streams through.
  const events = eventRepository.streamTraceEvents(
    getTaskEventStoreTableForRun(run),
    run.runtimeEnvironmentId,
    run.traceId,
    run.createdAt,
    run.completedAt ?? undefined,
    { includeDebugLogs: showDebug }
  );

  const context: TraceExportContext = {
    runFriendlyId: run.friendlyId,
    traceId: run.traceId,
    taskIdentifier: run.taskIdentifier,
    runUrl: `${env.APP_ORIGIN}${v3RunPath(
      run.project.organization,
      run.project,
      run.runtimeEnvironment,
      { friendlyId: run.friendlyId }
    )}`,
  };

  return streamGzipText(streamTraceExport(events, format, context), filename);
}

function streamGzipText(source: string | AsyncIterable<string>, filename: string): Response {
  // `Readable.from` handles both a single string and an async generator. For
  // the generator case it pulls lazily under backpressure, so a large trace is
  // never fully materialised in memory — gzip drains it as fast as the client
  // reads, and the generator pauses in between.
  const readable = typeof source === "string" ? Readable.from([source]) : Readable.from(source);
  const compressedStream = readable.pipe(createGzip());

  return new Response(compressedStream as any, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Encoding": "gzip",
    },
  });
}
