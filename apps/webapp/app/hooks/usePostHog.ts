import { useLocation } from "@remix-run/react";
import type { PostHog } from "posthog-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalOrganization, useOrganizationChanged } from "./useOrganizations";
import { useOptionalUser, useUserChanged } from "./useUser";
import { useOptionalProject, useProjectChanged } from "./useProject";
import { firstTouchFromPostHogProps, type FirstTouch } from "~/utils/firstTouch";
import { PostHogCaptureQueue } from "~/utils/postHogCaptureQueue";

// posthog-js is about 65 KB compressed and only starts after hydration, so it loads then
// instead of holding up the first interactive render. Events captured before it's ready
// wait in the capture queue.
let posthogClient: PostHog | undefined;
let posthogLoading: Promise<PostHog> | undefined;
function loadPostHog() {
  posthogLoading ??= import("posthog-js").then((module) => (posthogClient = module.default));
  return posthogLoading;
}

const captureQueue = new PostHogCaptureQueue((event, properties) =>
  posthogClient?.capture(event, properties)
);

export const usePostHog = (
  apiKey?: string,
  uiHost?: string,
  logging = false,
  debug = false
): void => {
  const postHogInitStarted = useRef(false);
  const postHogInitialized = useRef(false);
  const [postHogReady, setPostHogReady] = useState(false);
  const location = useLocation();
  const user = useOptionalUser();
  const organization = useOptionalOrganization();
  const project = useOptionalProject();

  //start PostHog once
  useEffect(() => {
    if (apiKey === undefined || apiKey === "") {
      captureQueue.disable();
      return;
    }
    if (postHogInitStarted.current === true) return;
    postHogInitStarted.current = true;
    if (logging) console.log("Initializing PostHog");
    loadPostHog().then(
      (posthog) => {
        posthog.init(apiKey, {
          // Same-origin first-party proxy (see app/routes/ph.$.ts) that forwards to
          // PostHog Cloud EU server-side.
          api_host: "/ph",
          // Point the toolbar at the real PostHog UI; without it, it falls back to /ph.
          ui_host: uiHost,
          cross_subdomain_cookie: true,
          opt_in_site_apps: true,
          person_profiles: "always",
          persistence: "cookie",
          capture_heatmaps: false,
          capture_dead_clicks: false,
          capture_exceptions: false,
          capture_performance: { web_vitals: false },
          disable_conversations: true,
          debug,
          loaded: function (posthog) {
            if (logging) console.log("PostHog loaded");
            if (user !== undefined) {
              if (logging) console.log("Loaded: Identifying user", user);
              posthog.identify(user.id, { email: user.email });
            }
            if (organization) posthog.group("organization", organization.id);
            if (project) posthog.group("project", project.id);
            captureQueue.ready();
          },
        });
        postHogInitialized.current = true;
        setPostHogReady(true);
      },
      () => captureQueue.disable()
    );
  }, [apiKey, uiHost, logging, debug, user, organization, project]);

  useUserChanged((user) => {
    const posthog = posthogClient;
    if (postHogInitialized.current === false || !posthog) return;
    if (logging) console.log("User changed");
    if (user) {
      if (logging) console.log("Identifying user", user);
      posthog.identify(user.id, { email: user.email });
    } else if (posthog.get_property("$user_state") === "identified") {
      if (logging) console.log("Resetting user");
      posthog.reset();
    }
  });

  useOrganizationChanged((org) => {
    const posthog = posthogClient;
    if (postHogInitialized.current === false || !posthog) return;
    if (org) {
      if (logging) console.log(`Grouping by organization`, org);
      posthog.group("organization", org.id);
    } else {
      //reset the groups when you go to one of the top-level pages
      if (logging) console.log("Resetting groups");
      posthog.resetGroups();
    }
  });

  useProjectChanged((project) => {
    const posthog = posthogClient;
    if (postHogInitialized.current === false || !posthog) return;
    if (project) {
      if (logging) console.log(`Grouping by project`, project);
      posthog.group("project", project.id);
    }
  });

  //page view (the first one fires once PostHog has loaded)
  useEffect(() => {
    if (!postHogReady) return;
    posthogClient?.capture("$pageview");
  }, [location, logging, postHogReady]);
};

export function usePostHogTracking() {
  const capture = useCallback((eventName: string, properties?: Record<string, unknown>) => {
    captureQueue.capture(eventName, properties);
  }, []);

  const startSessionRecording = useCallback(() => {
    posthogClient?.startSessionRecording();
  }, []);

  return { capture, startSessionRecording };
}

// The first touch PostHog stored for this browser; empty when PostHog isn't running or the user opted out.
export function readPostHogFirstTouch(): FirstTouch {
  try {
    const posthog = posthogClient;
    if (!posthog?.__loaded || posthog.has_opted_out_capturing()) return {};
    return firstTouchFromPostHogProps(posthog.persistence?.get_initial_props());
  } catch {
    return {};
  }
}
