import { useLocation } from "@remix-run/react";
import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { useOptionalCurrentEnvironment } from "~/routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug";
import { useCurrentOrganization } from "./useOrganizations";
import { useOptionalUser } from "./useUser";
import { useCurrentWorkflow } from "./useWorkflows";

export const usePostHog = (apiKey?: string, logging = false): void => {
  const postHogInitialized = useRef(false);
  const location = useLocation();
  const user = useOptionalUser();
  const currentOrganization = useCurrentOrganization();
  const currentOrganizationId = currentOrganization?.id;
  const currentWorkflow = useCurrentWorkflow();
  const currentWorkflowId = currentWorkflow?.id;
  const currentEnvironment = useOptionalCurrentEnvironment();
  const currentEnvironmentId = currentEnvironment?.id;

  //start PostHog once
  useEffect(() => {
    if (apiKey === undefined) return;
    if (postHogInitialized.current === true) return;
    if (logging) console.log("posthog.init", apiKey);
    postHogInitialized.current = true;
    posthog.init(apiKey, {
      api_host: "https://app.posthog.com",
      opt_in_site_apps: true,
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

  //identify the workflow
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    if (currentWorkflowId !== undefined) {
      if (logging) console.log("posthog.workflow", currentWorkflowId);
      posthog.group("workflow", currentWorkflowId);
    }
  }, [currentWorkflowId, logging]);

  //identify the environment
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    if (currentEnvironmentId !== undefined) {
      if (logging) console.log("posthog.environment", currentEnvironmentId);
      posthog.group("environment", currentEnvironmentId);
    }
  }, [currentEnvironmentId, logging]);

  //page view
  useEffect(() => {
    if (postHogInitialized.current === false) return;
    if (logging) console.log("posthog.capture", "$pageview", location.pathname);
    posthog.capture("$pageview");
  }, [location, logging]);
};
