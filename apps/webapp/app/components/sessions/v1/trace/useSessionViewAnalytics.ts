import { useCallback, useLayoutEffect, useRef } from "react";
import { useIsImpersonating } from "~/hooks/useOrganizations";
import { usePostHogTracking } from "~/hooks/usePostHog";
import { useOptionalUser } from "~/hooks/useUser";
import {
  SESSION_VIEW_EVENT,
  sessionViewer,
  sessionViewEventProperties,
  type SessionViewAction,
  type SessionViewProperties,
} from "./sessionViewAnalytics";

/** Sends session view actions to PostHog with the viewer and, when known, the runs shown. */
export function useSessionViewAnalytics(runsShown?: number) {
  const { capture } = usePostHogTracking();
  const user = useOptionalUser();
  const viewer = sessionViewer(user?.admin, useIsImpersonating());
  // Events fire from handlers and effects: they read the latest props through the ref.
  const shared = useRef({ viewer, runsShown });
  useLayoutEffect(() => {
    shared.current = { viewer, runsShown };
  });

  return useCallback(
    (action: SessionViewAction, extra?: SessionViewProperties) =>
      capture(SESSION_VIEW_EVENT, sessionViewEventProperties(action, shared.current, extra)),
    [capture]
  );
}
