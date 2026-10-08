import { useEffect, useRef, useState } from "react";

/** How long a tab stays hidden before its stream closes. Short tab switches keep it open. */
const EVENT_SOURCE_HIDDEN_GRACE_MS = 30_000;

type EventSourceOptions = {
  init?: EventSourceInit;
  event?: string;
  disabled?: boolean;
  /**
   * Close the stream once the tab has been hidden for `EVENT_SOURCE_HIDDEN_GRACE_MS`, and
   * reopen it when the tab is visible again. Defaults to true.
   */
  pauseWhenHidden?: boolean;
  /**
   * Called on every open after the first for the same stream: after a hidden pause or a
   * browser auto-reconnect. Use it to catch up when the server sends nothing on connect.
   */
  onReconnect?: () => void;
};

/**
 * Subscribe to an event source and return the latest event.
 * @param url The URL of the event source to connect to
 * @param options The options to pass to the EventSource constructor
 * @returns The last event received from the server, kept across a hidden pause
 */
export function useEventSource(
  url: string | URL,
  {
    event = "message",
    init,
    disabled,
    pauseWhenHidden = true,
    onReconnect,
  }: EventSourceOptions = {}
) {
  const [data, setData] = useState<string | null>(null);
  const paused = useHiddenPause(pauseWhenHidden && !disabled);

  const onReconnectRef = useRef(onReconnect);
  useEffect(() => {
    onReconnectRef.current = onReconnect;
  });
  // Set once the stream has opened, errored or closed. The next open then catches up.
  const interruptedRef = useRef(false);

  // Reset when the stream changes, but not when it reopens after a pause.
  useEffect(() => {
    interruptedRef.current = false;
    if (disabled) {
      return;
    }
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setData(null);
  }, [url, event, disabled]);

  useEffect(() => {
    if (disabled || paused) {
      return;
    }

    const eventSource = new EventSource(url, init);
    eventSource.addEventListener(event, handleMessage);
    eventSource.addEventListener("open", handleOpen);
    eventSource.addEventListener("error", handleError);

    function handleMessage(message: MessageEvent) {
      setData(message.data || "UNKNOWN_EVENT_DATA");
    }

    // `open` fires once the server has subscribed, so this catch-up covers anything
    // published while the stream was down.
    function handleOpen() {
      if (interruptedRef.current) {
        onReconnectRef.current?.();
      }
      interruptedRef.current = true;
    }

    function handleError() {
      interruptedRef.current = true;
    }

    return () => {
      eventSource.removeEventListener(event, handleMessage);
      eventSource.removeEventListener("open", handleOpen);
      eventSource.removeEventListener("error", handleError);
      eventSource.close();
      interruptedRef.current = true;
    };
  }, [url, event, init, disabled, paused]);

  return data;
}

/** True once the tab has been hidden for the grace period, until it is visible again. */
function useHiddenPause(enabled: boolean) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const startTimer = () => {
      timer ??= setTimeout(() => setPaused(true), EVENT_SOURCE_HIDDEN_GRACE_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        startTimer();
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      setPaused(false);
    };

    if (document.visibilityState === "hidden") {
      startTimer();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(timer);
      setPaused(false);
    };
  }, [enabled]);

  return paused;
}
