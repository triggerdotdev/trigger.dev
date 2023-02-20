import { LoaderArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { createEventEmitter } from "~/services/messageBroker.server";
import { requireUserId } from "~/services/session.server";

export async function loader({ request, params }: LoaderArgs) {
  const userId = await requireUserId(request);
  const { id } = z.object({ id: z.string() }).parse(params);

  const eventEmitter = await createEventEmitter({
    id: `${id}-${userId}`,
    filter: {
      "x-organization-template-id": id,
    },
  });

  return eventStream(request.signal, (send) => {
    eventEmitter.on("organization-template.updated", (data) => {
      send({ data: JSON.stringify(data) });
    });

    const timer = setInterval(() => {
      send({ event: "ping", data: new Date().toISOString() });
    }, 1000);

    return function clear() {
      eventEmitter.removeAllListeners();
      clearInterval(timer);
    };
  });
}

interface SendFunctionArgs {
  /**
   * @default "message"
   */
  event?: string;
  data: string;
}

interface SendFunction {
  (args: SendFunctionArgs): void;
}

interface CleanupFunction {
  (): void;
}

interface InitFunction {
  (send: SendFunction): CleanupFunction;
}

/**
 * A response holper to use Server Sent Events server-side
 * @param signal The AbortSignal used to close the stream
 * @param init The function that will be called to initialize the stream, here you can subscribe to your events
 * @returns A Response object that can be returned from a loader
 */
export function eventStream(signal: AbortSignal, init: InitFunction) {
  let stream = new ReadableStream({
    start(controller) {
      let encoder = new TextEncoder();

      function send({ event = "message", data }: SendFunctionArgs) {
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }

      let cleanup = init(send);

      let closed = false;

      function close() {
        if (closed) return;
        cleanup();
        closed = true;
        signal.removeEventListener("abort", close);
        controller.close();
      }

      signal.addEventListener("abort", close);

      if (signal.aborted) return close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
