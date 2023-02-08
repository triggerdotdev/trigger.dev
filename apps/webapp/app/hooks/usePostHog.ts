import { useLocation } from "@remix-run/react";
import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { useUser } from "./useUser";

export const usePostHog = (apiKey?: string): void => {
  const postHogInitialized = useRef(false);
  const location = useLocation();
  const user = useUser();

  //start PostHog once
  useEffect(() => {
    if (postHogInitialized.current === true) return;
    if (apiKey !== undefined) {
      posthog.init(apiKey, {
        api_host: "https://app.posthog.com",
        loaded: function (posthog) {
          if (user !== null) {
            posthog.identify(user.id, { email: user.email });
          }
          postHogInitialized.current = true;
        },
      });
    }
  }, [apiKey, user]);

  //identify the user, and unidentify on log out
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    if (user === null) {
      posthog.reset();
    } else {
      posthog.identify(user.id, { email: user.email });
    }
  }, [user]);

  //page view
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    posthog.capture("$pageview");
  }, [location]);
};
