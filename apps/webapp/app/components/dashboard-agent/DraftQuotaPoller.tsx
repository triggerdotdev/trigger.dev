import { useEffect, useState, type MutableRefObject } from "react";
import type { MessageQuota } from "./message-quota";
import { useAgentMessageQuota } from "./useAgentMessageQuota";

// Waited AFTER each read settles, not between starts: a read slower than this would otherwise
// be aborted by its own next tick and never land. Slow enough to be cheap for a panel left open
// on the upgrade block, quick enough that a quota switched off is picked up without a reload.
const DRAFT_QUOTA_POLL_MS = 30_000;

/**
 * Re-reads the quota while the draft is blocked by a cap, so the block is lifted as soon as a
 * read proves capacity — a refused `create` leaves no chat mounted, and with the composer
 * replaced by the upgrade block the user has no way to force the read themselves.
 *
 * The refusal generation is the panel's, so a read that started before the refusal it would be
 * clearing still fails the caller's `pollIsFresh` check.
 */
export function DraftQuotaPoller({
  actionPath,
  refusalGenRef,
  onQuotaChange,
}: {
  actionPath: string;
  refusalGenRef: MutableRefObject<number>;
  onQuotaChange: (
    quota: MessageQuota & { pollSeq: number; pollIsFresh: boolean; provenCapacity: boolean }
  ) => void;
}) {
  const [refreshTick, setRefreshTick] = useState(0);
  // No chat to key on and no turn to settle: the mount read plus the ticks below are the reads.
  const quota = useAgentMessageQuota({
    actionPath,
    chatId: "draft",
    status: "ready",
    refusalGenRef,
    refreshTick,
    // The server caps from the org's billing limit, not the plan tier, so a paid org can hold
    // a refusal too — and the free-plan-only routine poll would never read its release.
    alwaysPoll: true,
  });
  // Armed only once a read has settled, so exactly one is ever in flight and the mount read
  // gets as long as it needs.
  useEffect(() => {
    if (quota.settleSeq === 0) return;
    const timer = setTimeout(() => setRefreshTick((tick) => tick + 1), DRAFT_QUOTA_POLL_MS);
    return () => clearTimeout(timer);
  }, [quota.settleSeq]);
  useEffect(() => {
    onQuotaChange(quota);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quota.pollSeq, onQuotaChange]);
  return null;
}
