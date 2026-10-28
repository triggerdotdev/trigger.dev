import { useLocation, useNavigation } from "@remix-run/react";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "~/hooks/useSearchParam";
import {
  isSameSelection,
  parseSessionTraceSelection,
  SESSION_RUN_PARAM,
  SESSION_SPAN_PARAM,
  selectionSearchValues,
  type SessionTraceSelection,
} from "./sessionTraceSelection";

/** The session page's selection, kept in `?run=&span=`. Writes replace the history entry. */
export function useSessionTraceSelection() {
  const { value, replace } = useSearchParams();
  const { pathname } = useLocation();
  const navigation = useNavigation();
  // A delayed write landing while another page loads would put ?run= on it and cancel the move.
  const leavingPage =
    navigation.location !== undefined && navigation.location.pathname !== pathname;
  const run = value(SESSION_RUN_PARAM);
  const span = value(SESSION_SPAN_PARAM);

  const selection = useMemo(() => {
    const params = new URLSearchParams();
    if (run) params.set(SESSION_RUN_PARAM, run);
    if (span) params.set(SESSION_SPAN_PARAM, span);
    return parseSessionTraceSelection(params);
  }, [run, span]);

  const setSelection = useCallback(
    (next: SessionTraceSelection) => {
      if (leavingPage || isSameSelection(selection, next)) return;
      replace(selectionSearchValues(next));
    },
    [selection, replace, leavingPage]
  );

  return { selection, setSelection };
}
