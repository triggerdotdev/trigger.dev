/** Retry transient stream failures without losing the caller's sequence cursor. */
export async function readDeploymentLogsWithRecovery({
  read,
  signal,
  onError,
  onConnected,
  canRetry,
  delays = [1_000, 2_000, 4_000, 8_000, 16_000],
}: {
  read: () => Promise<void>;
  signal: AbortSignal;
  onError: (retrying: boolean) => void;
  onConnected: () => void;
  canRetry: (error: unknown) => boolean;
  delays?: readonly number[];
}) {
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      await read();
      if (!signal.aborted) onConnected();
      return;
    } catch (error) {
      if (signal.aborted) return;
      const delay = delays[attempt];
      const retrying = delay !== undefined && canRetry(error);
      onError(retrying);
      if (!retrying) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, delay);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
}
