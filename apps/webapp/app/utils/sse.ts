import { eventStream } from "remix-utils";

type SseProps = {
  request: Request;
  pingInterval?: number;
  updateInterval?: number;
  run: (send: (event: Event) => void, stop: () => void) => void;
};

type Event = {
  /**
   * @default "update"
   */
  event?: string;
  data: string;
};

export function sse({ request, pingInterval = 1000, updateInterval = 348, run }: SseProps) {
  let pinger: NodeJS.Timer | undefined = undefined;
  let updater: NodeJS.Timer | undefined = undefined;

  const abort = () => {
    if (pinger) {
      clearInterval(pinger);
    }

    if (updater) {
      clearInterval(updater);
    }
  };

  return eventStream(request.signal, (send) => {
    pinger = setInterval(() => {
      send({ event: "ping", data: new Date().toISOString() });
    }, pingInterval);

    updater = setInterval(async () => {
      run(send, abort);
    }, updateInterval);

    return abort;
  });
}
