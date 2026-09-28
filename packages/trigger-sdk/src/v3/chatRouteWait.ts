import {
  type SessionChannelRouter,
  type SessionStreamRecord,
  WaitpointTimeoutError,
} from "@trigger.dev/core/v3";
import { parseNaturalLanguageDurationInMs } from "@trigger.dev/core/v3/isomorphic";

const POST_WAKE_TIMEOUT_MS = 5_000;

type ChatRouteWakeResult = { ok: true; waitpointId: string } | { ok: false; error: Error };

export async function waitForChatRouteAfterIdle(
  router: SessionChannelRouter,
  route: string,
  options: {
    timeout?: string;
    postWakeTimeoutMs?: number;
    now?: () => number;
    wake: (
      timeout: string | undefined,
      lastSeqNum: number | undefined
    ) => Promise<ChatRouteWakeResult>;
  }
): Promise<{ ok: true; record: SessionStreamRecord } | { ok: false; error: Error }> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeout ? parseNaturalLanguageDurationInMs(options.timeout) : undefined;
  const parsedDeadline =
    timeoutMs !== undefined
      ? now() + timeoutMs
      : options.timeout === undefined
        ? undefined
        : Date.parse(options.timeout);
  const deadline =
    parsedDeadline !== undefined && Number.isFinite(parsedDeadline) ? parsedDeadline : undefined;
  const postWakeTimeoutMs = options.postWakeTimeoutMs ?? POST_WAKE_TIMEOUT_MS;

  while (true) {
    const remainingMs = deadline === undefined ? undefined : deadline - now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return { ok: false, error: new WaitpointTimeoutError("Timed out") };
    }

    const wakeTimeout =
      remainingMs === undefined
        ? options.timeout
        : `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
    // A queued record holds the replay floor back, but should not wake this
    // waitpoint again after we have already seen it. Snapshot before checking
    // the route so a record arriving during registration still wakes us.
    const wakeFrom = router.appliedThrough();
    const buffered = await router.next(route, { timeoutMs: 0 });
    if (buffered) return { ok: true, record: buffered };

    const wake = await options.wake(wakeTimeout, wakeFrom);
    if (!wake.ok) return wake;

    const deliveryBudget =
      deadline === undefined
        ? postWakeTimeoutMs
        : Math.max(0, Math.min(postWakeTimeoutMs, deadline - now()));
    const record = await router.next(route, { timeoutMs: deliveryBudget });
    if (record) return { ok: true, record };
  }
}
