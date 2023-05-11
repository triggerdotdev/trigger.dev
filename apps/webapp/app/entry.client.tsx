import { RemixBrowser, useLocation, useMatches } from "@remix-run/react";
import { hydrateRoot } from "react-dom/client";
import * as Sentry from "@sentry/remix";
import { useEffect } from "react";
import posthog from "posthog-js";
import { LocaleContextProvider } from "./components/primitives/LocaleProvider";

hydrateRoot(
  document,
  <LocaleContextProvider locales={window.navigator.languages as string[]}>
    <RemixBrowser />
  </LocaleContextProvider>
);

//hack because the type is not exported
type SentryIntegration = (typeof Sentry.defaultIntegrations)[number];

if (process.env.NODE_ENV === "production") {
  Sentry.init({
    dsn: "https://bf96820b08004fa4b2e1506f2ac74a14@o4504419574087680.ingest.sentry.io/4504419607052288",
    tracesSampleRate: 1,
    integrations: [
      new Sentry.BrowserTracing({
        routingInstrumentation: Sentry.remixRouterInstrumentation(
          useEffect,
          useLocation,
          useMatches
        ),
      }),
      //casted because TypeScript is unhappy about the type from PostHog
      new posthog.SentryIntegration(
        posthog,
        "triggerdev",
        4504419607052288
      ) as SentryIntegration,
    ],
  });
}
