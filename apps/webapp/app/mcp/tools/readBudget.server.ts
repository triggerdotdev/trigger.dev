export const READ_BUDGET_MS = 15_000;

export const NONE_FOUND =
  "None were found; this can also mean the usage data could not be read right now.";

const STOPPED = {
  timeout: "Reading this took too long and was stopped. Try a shorter period.",
  aborted: "The request was cancelled before the read finished.",
};

type Stopped = { ok: false; reason: keyof typeof STOPPED };
type Read<T> = { ok: true; value: T } | Stopped;

export const stoppedText = (stopped: Stopped) => STOPPED[stopped.reason];

/** One deadline for a tool call: whether it has passed, what is left, and the ClickHouse cap from it. */
export function startReadBudget(
  budgetMs: number,
  signal: AbortSignal,
  now: () => number = Date.now
) {
  const deadline = now() + budgetMs;
  const remainingMs = () => Math.max(0, deadline - now());
  const stopped = (): Stopped | undefined =>
    signal.aborted
      ? { ok: false, reason: "aborted" }
      : remainingMs() === 0
        ? { ok: false, reason: "timeout" }
        : undefined;
  return {
    remainingMs,
    limit: () => ({ maxExecutionSeconds: Math.max(1, Math.ceil(remainingMs() / 1000)) }),
    /** Starts the read only while the call is live, and stops waiting for it at the deadline or on cancel. */
    read: <T>(start: () => Promise<T>): Promise<Read<T>> => {
      const stop = stopped();
      return stop ? Promise.resolve(stop) : withinBudget(start(), remainingMs(), signal);
    },
  };
}

async function withinBudget<T>(
  read: Promise<T>,
  budgetMs: number,
  signal: AbortSignal
): Promise<Read<T>> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<Stopped>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), budgetMs);
    onAbort = () => resolve({ ok: false, reason: "aborted" });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([read.then((value) => ({ ok: true as const, value })), stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
