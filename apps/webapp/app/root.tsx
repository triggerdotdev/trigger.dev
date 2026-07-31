import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExternalScripts } from "remix-utils/external-scripts";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
// Fonts imported here so Vite rebases the urls and emits the woff2 assets
import "non.geist";
import "non.geist/mono";
import tailwindStylesheetUrl from "~/tailwind.css?url";
import { RouteErrorDisplay } from "./components/ErrorDisplay";
import { GlobalShortcuts } from "./components/GlobalShortcuts";
import { StaleAssetRecovery } from "./components/StaleAssetRecovery";
import { AppContainer, MainCenteredContainer } from "./components/layout/AppLayout";
import { ShortcutsProvider } from "./components/primitives/ShortcutsProvider";
import { Toast } from "./components/primitives/Toast";
import { TimezoneSetter } from "./components/TimezoneSetter";
import { env } from "./env.server";
import { featuresForRequest } from "./features.server";
import { usePostHog } from "./hooks/usePostHog";
import { getImpersonationState } from "./services/impersonation.server";
import { getUser } from "./services/session.server";
import { getTimezonePreference } from "./services/preferences/uiPreferences.server";
import { appEnvTitleTag } from "./utils";

// Derived here (not inside StaleAssetRecovery) so the shared component takes
// the flag as a prop. NODE_ENV is statically replaced in browser bundles, and
// the ErrorBoundary can't rely on loader data.
const isProduction = process.env.NODE_ENV === "production";

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: tailwindStylesheetUrl }];
};

export const headers = () => ({
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy":
    "geolocation=(), microphone=(), camera=(), accelerometer=(), gyroscope=(), magnetometer=(), payment=(), usb=()",
});

export const meta: MetaFunction = ({ data }) => {
  const typedData = data as UseDataFunctionReturn<typeof loader>;
  return [
    { title: typedData?.appEnv ? `Trigger.dev${appEnvTitleTag(typedData.appEnv)}` : "Trigger.dev" },
    {
      name: "viewport",
      content: "width=1024, initial-scale=1",
    },
    {
      name: "robots",
      content:
        typeof window === "undefined" || window.location.hostname !== "cloud.trigger.dev"
          ? "noindex, nofollow"
          : "index, follow",
    },
  ];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await getSession(request.headers.get("cookie"));
  const toastMessage = session.get("toastMessage") as ToastMessage;
  const posthogProjectKey = env.POSTHOG_PROJECT_KEY;
  const posthogUiHost = env.POSTHOG_HOST;
  const features = featuresForRequest(request);
  const timezone = await getTimezonePreference(request);

  const kapa = {
    websiteId: env.KAPA_AI_WEBSITE_ID,
  };

  const user = await getUser(request);
  // Display-only: while impersonating, an admin can ask to see the dashboard
  // the way the impersonated user sees it. Exposed from root so every route can
  // read it.
  //
  // Resolved against the user this request authenticated as, which is the same
  // condition `requireUser` applies — otherwise the flag the client reads and
  // the `user.isViewingAsUser` the server computes could disagree, and the
  // client-side admin UI would hide itself on a session that is not
  // impersonating.
  const { isViewingAsUser } = await getImpersonationState(request, user?.id);

  const headers = new Headers();
  headers.append("Set-Cookie", await commitSession(session));

  return typedjson(
    {
      user,
      isViewingAsUser,
      toastMessage,
      posthogProjectKey,
      posthogUiHost,
      features,
      appEnv: env.APP_ENV,
      appOrigin: env.APP_ORIGIN,
      apiOrigin: env.API_ORIGIN ?? env.APP_ORIGIN,
      triggerCliTag: env.TRIGGER_CLI_TAG,
      kapa,
      timezone,
    },
    { headers }
  );
};

export type LoaderType = typeof loader;

export const shouldRevalidate: ShouldRevalidateFunction = (options) => {
  if (options.formAction === "/resources/environment") {
    return false;
  }

  return options.defaultShouldRevalidate;
};

export function ErrorBoundary() {
  return (
    <>
      <html lang="en" className="h-full" data-theme="dark">
        <head>
          <meta charSet="utf-8" />

          <StaleAssetRecovery isProduction={isProduction} />
          <Meta />
          <Links />
        </head>
        <body className="h-full overflow-hidden bg-background-dimmed antialiased">
          <ShortcutsProvider>
            <AppContainer>
              <MainCenteredContainer>
                <RouteErrorDisplay />
              </MainCenteredContainer>
            </AppContainer>
          </ShortcutsProvider>
          <Scripts />
        </body>
      </html>
    </>
  );
}

export default function App() {
  const { posthogProjectKey, posthogUiHost, kapa: _kapa } = useTypedLoaderData<typeof loader>();
  usePostHog(posthogProjectKey, posthogUiHost);

  return (
    <>
      <html lang="en" className="h-full" data-theme="dark">
        <head>
          <StaleAssetRecovery isProduction={isProduction} />
          <Meta />
          <Links />
        </head>
        <body className="h-full overflow-hidden bg-background-dimmed antialiased">
          <ShortcutsProvider>
            <TimezoneSetter />
            <GlobalShortcuts />
            <Outlet />
            <Toast />
          </ShortcutsProvider>
          <ScrollRestoration />
          <ExternalScripts />
          <Scripts />
        </body>
      </html>
    </>
  );
}
