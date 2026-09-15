import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatOpenMode } from "~/utils/dashboardPreferences";

export const CHAT_OPEN_MODE_SAVE_ERROR = "Couldn't save your chat position. Please try again.";

export type ChatOpenModePickerDeps = {
  /** The saved preference; catches up once a write lands and the route revalidates. */
  stored: ChatOpenMode;
  fetcherState: "idle" | "loading" | "submitting";
  fetcherData: { success: boolean; error?: string } | undefined;
  submit: (mode: ChatOpenMode) => void;
  onError: (message: string) => void;
};

/**
 * One write in flight at a time, so two quick picks can't land out of order and persist
 * the earlier one; the later pick goes out when the first settles.
 *
 * A failure rolls the picker back to `stored` and is never retried on its own — only a
 * fresh pick sends again — while a pick queued behind the failed write still goes out.
 */
export function useChatOpenModePicker({
  stored,
  fetcherState,
  fetcherData,
  submit,
  onError,
}: ChatOpenModePickerDeps) {
  const [desired, setDesired] = useState<ChatOpenMode>(stored);
  // What the in-flight write is storing, so a lagging revalidation can't resend it.
  const sentRef = useRef<ChatOpenMode>(stored);
  // The value a write just failed on; cleared by the next explicit pick.
  const failedRef = useRef<ChatOpenMode | null>(null);
  const submitSeenRef = useRef(false);

  const pick = useCallback((next: ChatOpenMode) => {
    failedRef.current = null;
    setDesired(next);
  }, []);

  useEffect(() => {
    if (fetcherState !== "idle") {
      submitSeenRef.current = true;
      return;
    }
    // Once per flight: `fetcherData` keeps the last result, so an unguarded settle
    // branch would fire on every later render too.
    if (!submitSeenRef.current) return;
    submitSeenRef.current = false;
    if (fetcherData?.success) {
      failedRef.current = null;
      return;
    }

    onError(fetcherData?.error ?? CHAT_OPEN_MODE_SAVE_ERROR);
    const failed = sentRef.current;
    failedRef.current = failed;
    // Only roll back the value that failed. A pick made while it was in flight is
    // still what the user wants, so it is left for the reconcile below to send.
    if (desired === failed) {
      sentRef.current = stored;
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
      setDesired(stored);
    }
  }, [fetcherState, fetcherData, stored, desired, onError]);

  useEffect(() => {
    if (fetcherState !== "idle") return;
    if (desired === stored) return;
    if (desired === sentRef.current) return;
    if (desired === failedRef.current) return;
    sentRef.current = desired;
    submit(desired);
  }, [desired, stored, fetcherState, submit]);

  return { desired, pick };
}
