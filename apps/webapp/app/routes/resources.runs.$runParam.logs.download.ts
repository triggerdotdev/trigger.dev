import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import {
  PreparedEvent,
  RunPreparedEvent,
  eventRepository,
  getDateFromNanoseconds,
} from "~/v3/eventRepository.server";
import { createGzip } from "zlib";
import { Readable } from "stream";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const parsedParams = v3RunParamsSchema.pick({ runParam: true }).parse(params);

  const run = await prisma.taskRun.findFirst({
    where: {
      friendlyId: parsedParams.runParam,
      project: {
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    },
  });

  if (!run) {
    return new Response("Not found", { status: 404 });
  }

  const runEvents = await eventRepository.getRunEvents(run.friendlyId);

  // Create a Readable stream from the runEvents array
  const readable = new Readable({
    read() {
      runEvents.forEach((event) => {
        try {
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
