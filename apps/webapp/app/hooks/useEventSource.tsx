import { useEffect, useState } from "react";

type EventSourceOptions = {
  init?: EventSourceInit;
  event?: string;
  disabled?: boolean;
};

/**
 * Subscribe to an event source and return the latest event.
 * @param url The URL of the event source to connect to
 * @param options The options to pass to the EventSource constructor
 * @returns The last event received from the server
 */
export function useEventSource(
  url: string | URL,
  { event = "message", init, disabled }: EventSourceOptions = {}
) {
  const [data, setData] = useState<string | null>(null);

  useEffect(() => {
    if (disabled) {
      return;
    }

    // reset data if dependencies change
    setData(null);

    const eventSource = new EventSource(url, init);
    eventSource.addEventListener(event ?? "message", handler);

    function handler(event: MessageEvent) {
      setData(event.data || "UNKNOWN_EVENT_DATA");
    }

    return () => {
      eventSource.removeEventListener(event ?? "message", handler);
      eventSource.close();
    };
  }, [url, event, init, disabled]);

  return data;
}
