import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/session.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import type { RunPreparedEvent } from "~/v3/eventRepository/eventRepository.types";
import { createGzip } from "zlib";
import { Readable } from "stream";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { TaskEventKind } from "@trigger.dev/database";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const parsedParams = v3RunParamsSchema.pick({ runParam: true }).parse(params);

  const run = await prisma.taskRun.findFirst({
    where: {
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
  });

  if (!run || !run.organizationId) {
    // Buffered run? It hasn't executed, so there are no events to
    // stream — but a 404 is wrong: the run does exist, the customer's
    // "Download logs" button on the run-detail page generates this
    // exact URL, and a 404 reads as "your run vanished" rather than
    // "no logs yet". Verify the entry exists in the buffer (with the
    // user as a member of the entry's org), and if so stream a single
    // informational line in the same `<timestamp> <task> <level>
    // <message>` shape `formatRunEvent` uses below — so a downstream
    // log viewer / grep over the downloaded file produces a
    // meaningful explanation, not a 0-byte mystery.
    const buffer = getMollifierBuffer();
    if (buffer) {
      const entry = await buffer.getEntry(parsedParams.runParam);
      if (entry) {
        const member = await prisma.orgMember.findFirst({
          where: { userId: user.id, organizationId: entry.orgId },
          select: { id: true },
        });
        if (member) {
          let taskIdentifier: string | undefined;
          try {
            const snapshot = JSON.parse(entry.payload) as { taskIdentifier?: unknown };
            if (typeof snapshot.taskIdentifier === "string") {
              taskIdentifier = snapshot.taskIdentifier;
            }
          } catch {
            // Fall through — taskIdentifier stays undefined.
          }
          const placeholderParts = [
            entry.createdAt.toISOString(),
            ...(taskIdentifier ? [taskIdentifier] : []),
            "INFO",
            "Run is queued, has not started executing yet — no logs to download.",
          ];
          const placeholder = placeholderParts.join(" ") + "\n";
          const placeholderReadable = new Readable({
            read() {
              this.push(placeholder);
              this.push(null);
            },
          });
          const gzipStream = createGzip();
          const compressed = placeholderReadable.pipe(gzipStream);
          return new Response(compressed as any, {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${parsedParams.runParam}.log"`,
              "Content-Encoding": "gzip",
            },
          });
        }
      }
    }
    return new Response("Not found", { status: 404 });
  }

  const eventRepository = await getEventRepositoryForStore(
    run.taskEventStore,
    run.organizationId
  );

  const runEvents = await eventRepository.getRunEvents(
    getTaskEventStoreTableForRun(run),
    run.runtimeEnvironmentId,
    run.traceId,
    run.friendlyId,
    run.createdAt,
    run.completedAt ?? undefined
  );

  // Create a Readable stream from the runEvents array
  const readable = new Readable({
    read() {
      runEvents.forEach((event) => {
        try {
          if (!user.admin && event.kind === TaskEventKind.LOG) {
            // Only return debug logs for admins
            return;
          }
          this.push(formatRunEvent(event) + "\n");
        } catch {}
      });
      this.push(null); // End of stream
    },
  });

  // Create a gzip transform stream
  const gzip = createGzip();

  // Pipe the readable stream into the gzip stream
  const compressedStream = readable.pipe(gzip);

  // Return the response with the compressed stream
  return new Response(compressedStream as any, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${parsedParams.runParam}.log"`,
      "Content-Encoding": "gzip",
    },
  });
}

function formatRunEvent(event: RunPreparedEvent): string {
  const entries = [];
  const parts: string[] = [];

  parts.push(getDateFromNanoseconds(event.startTime).toISOString());

  if (event.taskSlug) {
    parts.push(event.taskSlug);
  }

  parts.push(event.level);
  parts.push(event.message);

  if (event.level === "TRACE") {
    parts.push(`(${formatDurationMilliseconds(event.duration / 1_000_000)})`);
  }

  entries.push(parts.join(" "));

  if (event.events) {
    for (const subEvent of event.events) {
      if (subEvent.name === "exception") {
        const subEventParts: string[] = [];

        subEventParts.push(subEvent.time as unknown as string);

        if (event.taskSlug) {
          subEventParts.push(event.taskSlug);
        }

        subEventParts.push(subEvent.name);
        subEventParts.push((subEvent.properties as any).exception.message);

        if ((subEvent.properties as any).exception.stack) {
          subEventParts.push((subEvent.properties as any).exception.stack);
        }

        entries.push(subEventParts.join(" "));
      }
    }
  }

  return entries.join("\n");
}

function getDateFromNanoseconds(nanoseconds: bigint) {
  return new Date(Number(nanoseconds) / 1_000_000);
}
