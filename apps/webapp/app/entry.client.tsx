import { RemixBrowser, useLocation, useMatches } from "@remix-run/react";
import { hydrateRoot } from "react-dom/client";
import * as Sentry from "@sentry/remix";
import { useEffect } from "react";

hydrateRoot(document, <RemixBrowser />);

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
    ],
  });
}
