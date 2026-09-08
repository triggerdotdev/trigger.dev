import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import {
  quotaResponseUpdate,
  resolveMessageLimit,
  resolveMessageQuota,
  type MessageQuota,
} from "./message-quota";

// Gated on billing PRESENCE, not the plan value: no subscription means billing isn't wired
// up (self-hosted), so there is no cap and no upgrade UI. A wired-up, non-paying plan is free.
function useIsFreePlan(): boolean | undefined {
  const subscription = useCurrentPlan()?.v3Subscription;
  if (!subscription) return undefined;
  return subscription.isPaying === false;
}

// A read that never settles would arm no retry, so a caller pacing itself off `settleSeq`
// would stall for good. Longer than the draft poller's 30s gap, so a merely slow read still
// lands on its own. Shared with the chat's routine polling, where it is harmless.
const QUOTA_READ_DEADLINE_MS = 60_000;

// `used` is the server's per-period count for the org. Re-read once a turn settles — the
// server increment happens mid-turn in the `.in` proxy, so reading on optimistic append
// would lag the count by one message and show the cap a message late.
export function useAgentMessageQuota({
  actionPath,
  chatId,
  status,
  refusalGenRef,
  refreshTick = 0,
  alwaysPoll = false,
}: {
  actionPath: string;
  chatId: string;
  status: string;
  /**
   * Owned by the caller (shared across chat switches, unlike this hook's own instance): bumped
   * every time a send is refused over the cap. Ordering by generation, not the wall clock,
   * because two events racing in the same millisecond would otherwise tie under `Date.now()`.
   */
  refusalGenRef: MutableRefObject<number>;
  /**
   * Bumped by a caller with no turns to settle (the capped draft) to force a re-read, so a
   * quota switched off after mount is still observed.
   */
  refreshTick?: number;
  /**
   * Read whatever the plan is. Routine polling is free-plan-only — that's where the nudge
   * lives — but the server resolves the cap from the org's billing limit and can refuse any
   * plan, so a caller holding a refusal must be able to read the release signal.
   */
  alwaysPoll?: boolean;
}): MessageQuota & {
  pollSeq: number;
  pollIsFresh: boolean;
  provenCapacity: boolean;
  settleSeq: number;
} {
  const isFreePlan = useIsFreePlan();
  const [used, setUsed] = useState<number | undefined>(undefined);
  const [serverLimit, setServerLimit] = useState<number | null>(null);
  // Explicit server signal, not inferred from an absent read: a client mounted while the
  // quota was on must drop its cached used/limit (and any cap-reached block) the moment the
  // switch flips off, rather than keeping the stale state until remount.
  const [disabled, setDisabled] = useState(false);
  // Bumped on every authoritative response (a coherent read or a disabled signal), never on a
  // degraded `{}`. A caller latching a cap needs this even when `kind`/`reason` come back
  // unchanged — e.g. within → (403) → within again — so it re-checks on each read instead of
  // only on a value change.
  const [pollSeq, setPollSeq] = useState(0);
  // Whether the CURRENT poll's result can be trusted to lift a cap: its fetch must have
  // started at the same refusal generation it resolved at. A refusal that lands while this
  // poll is still in flight bumps the ref, so the two won't match and this stays false —
  // the stale in-flight read must not be read as proof a cap the refusal just set is gone.
  const [pollIsFresh, setPollIsFresh] = useState(false);
  // Bumped when a read finishes, however it finished — a good body, a failure, a degraded
  // `{}`. A caller pacing its own re-reads arms the next one off this, so a read slower than
  // its delay is never cut off by its own next tick. Not bumped on an abort: a fresh read is
  // already replacing that one.
  const [settleSeq, setSettleSeq] = useState(0);

  // Bumped each time the status leaves streaming/submitted, which drives the re-read.
  const [settleTick, setSettleTick] = useState(0);
  const prevStatus = useRef(status);
  useEffect(() => {
    const wasInFlight = prevStatus.current === "streaming" || prevStatus.current === "submitted";
    const nowSettled = status === "ready" || status === "error";
    prevStatus.current = status;
    if (wasInFlight && nowSettled) setSettleTick((tick) => tick + 1);
  }, [status]);

  useEffect(() => {
    if (!alwaysPoll && isFreePlan !== true) return;
    const controller = new AbortController();
    const startedGen = refusalGenRef.current;
    // Distinguishes the two aborts: a deadline is an outcome and must settle, while a cleanup
    // abort (unmount, or a dep change already starting the next read) must not.
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, QUOTA_READ_DEADLINE_MS);
    void (async () => {
      try {
        const res = await fetch(`${actionPath}?quota=1`, { signal: controller.signal });
        if (!res.ok) return;
        const update = quotaResponseUpdate(
          (await res.json()) as { used?: number; limit?: number | null; enabled?: boolean }
        );
        if (!update) return;
        setPollSeq((seq) => seq + 1);
        setPollIsFresh(startedGen === refusalGenRef.current);
        if ("disabled" in update) {
          setUsed(undefined);
          setServerLimit(null);
          setDisabled(true);
          return;
        }
        setDisabled(false);
        setUsed(update.used);
        setServerLimit(update.limit);
      } catch {
        // Leave the count unknown, which means no cap. See `resolveMessageQuota`.
      } finally {
        clearTimeout(deadline);
        if (timedOut || !controller.signal.aborted) setSettleSeq((seq) => seq + 1);
      }
    })();
    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, [isFreePlan, alwaysPoll, actionPath, chatId, settleTick, refreshTick, refusalGenRef]);

  // The server's own verdict, before the plan model reshapes it: a finite limit it sent with
  // room left under it. Only a limit the SERVER set counts — a null one falls back to the
  // client's free-plan nudge, which must keep gating the free plan's own block.
  const provenCapacity =
    !disabled && used !== undefined && serverLimit !== null ? used < serverLimit : false;

  return {
    ...resolveMessageQuota({
      isFreePlan,
      used,
      limit: resolveMessageLimit(serverLimit),
      disabled,
    }),
    pollSeq,
    pollIsFresh,
    provenCapacity,
    settleSeq,
  };
}
