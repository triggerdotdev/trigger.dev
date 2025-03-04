import { useLocation } from "@remix-run/react";
import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { useOrganizationChanged } from "./useOrganizations";
import { useOptionalUser, useUserChanged } from "./useUser";
import { useProjectChanged } from "./useProject";

export const usePostHog = (apiKey?: string, logging = false, debug = false): void => {
  const postHogInitialized = useRef(false);
  const location = useLocation();
  const user = useOptionalUser();

  //start PostHog once
  useEffect(() => {
    if (apiKey === undefined || apiKey === "") return;
    if (postHogInitialized.current === true) return;
    if (logging) console.log("Initializing PostHog");
    posthog.init(apiKey, {
      api_host: "https://eu.posthog.com",
      opt_in_site_apps: true,
      debug,
      loaded: function (posthog) {
        if (logging) console.log("PostHog loaded");
        if (user !== undefined) {
          if (logging) console.log("Loaded: Identifying user", user);
          posthog.identify(user.id, { email: user.email });
        }
      },
    });
    postHogInitialized.current = true;
  }, [apiKey, logging, user]);

  useUserChanged((user) => {
    if (postHogInitialized.current === false) return;
    if (logging) console.log("User changed");
    if (user) {
      if (logging) console.log("Identifying user", user);
      posthog.identify(user.id, { email: user.email });
    } else {
      if (logging) console.log("Resetting user");
      posthog.reset();
    }
  });

  useOrganizationChanged((org) => {
    if (postHogInitialized.current === false) return;
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
    if (postHogInitialized.current === false) return;
    if (project) {
      if (logging) console.log(`Grouping by project`, project);
      posthog.group("project", project.id);
    }
  });

  //page view
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    posthog.capture("$pageview");
  }, [location, logging]);
};
