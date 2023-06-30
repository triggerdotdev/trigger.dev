import { useLocation } from "@remix-run/react";
import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { useOptionalOrganization } from "./useOrganizations";
import { useOptionalUser } from "./useUser";

export const usePostHog = (apiKey?: string, logging = false): void => {
  const postHogInitialized = useRef(false);
  const location = useLocation();
  const user = useOptionalUser();
  const currentOrganization = useOptionalOrganization();
  const currentOrganizationId = currentOrganization?.id;

  //start PostHog once
  useEffect(() => {
    if (apiKey === undefined) return;
    if (apiKey === "") return;
    if (postHogInitialized.current === true) return;
    if (logging) console.log("posthog.init", apiKey);
    postHogInitialized.current = true;
    posthog.init(apiKey, {
      api_host: "https://app.posthog.com",
      opt_in_site_apps: true,
      debug: logging,
      loaded: function (posthog) {
        if (logging) console.log("posthog.loaded", apiKey);
        if (user !== undefined) {
          if (logging) console.log("posthog.identify", user.id, user.email);
          posthog.identify(user.id, { email: user.email });
        }
      },
    });
  }, [apiKey, logging, user]);

  //identify the user, and unidentify on log out
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    if (user === undefined) {
      if (logging) console.log("posthog.reset");
      posthog.reset();
    } else {
      if (logging) console.log("posthog.identify", user.id, user.email);
      posthog.identify(user.id, { email: user.email });
    }
  }, [logging, user]);

  //identify the organization
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    if (currentOrganizationId !== undefined) {
      if (logging) console.log("posthog.organization", currentOrganizationId);
      posthog.group("organization", currentOrganizationId);
    }
  }, [currentOrganizationId, logging]);

  //page view
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    if (logging) console.log("posthog.capture", "$pageview", location.pathname);
    posthog.capture("$pageview");
  }, [location, logging]);
};
