import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Links, LiveReload, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExternalScripts } from "remix-utils/external-scripts";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import tailwindStylesheetUrl from "~/tailwind.css";
import { RouteErrorDisplay } from "./components/ErrorDisplay";
import { AppContainer, MainCenteredContainer } from "./components/layout/AppLayout";
import { ShortcutsProvider } from "./components/primitives/ShortcutsProvider";
import { ThemeProvider, ThemeScript } from "./components/primitives/ThemeProvider";
import { Toast } from "./components/primitives/Toast";
import { env } from "./env.server";
import { featuresForRequest } from "./features.server";
import { usePostHog } from "./hooks/usePostHog";
import { getUser } from "./services/session.server";
import { appEnvTitleTag } from "./utils";
import type { ThemePreference } from "./services/dashboardPreferences.server";

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
  const features = featuresForRequest(request);

  const kapa = {
    websiteId: env.KAPA_AI_WEBSITE_ID,
  };

  const user = await getUser(request);
  const themePreference: ThemePreference = user?.dashboardPreferences?.theme ?? "dark";

  return typedjson(
    {
      user,
      toastMessage,
      posthogProjectKey,
      features,
      appEnv: env.APP_ENV,
      appOrigin: env.APP_ORIGIN,
      triggerCliTag: env.TRIGGER_CLI_TAG,
      kapa,
      themePreference,
    },
    { headers: { "Set-Cookie": await commitSession(session) } }
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
      <html lang="en" className="h-full dark">
        <head>
          <meta charSet="utf-8" />
          <ThemeScript />
          <Meta />
          <Links />
        </head>
        <body className="h-full overflow-hidden bg-background-dimmed">
          <ThemeProvider initialPreference="dark" isLoggedIn={false}>
            <ShortcutsProvider>
              <AppContainer>
                <MainCenteredContainer>
                  <RouteErrorDisplay />
                </MainCenteredContainer>
              </AppContainer>
            </ShortcutsProvider>
          </ThemeProvider>
          <Scripts />
        </body>
      </html>
    </>
  );
}

export default function App() {
  const { posthogProjectKey, kapa, themePreference, user } = useTypedLoaderData<typeof loader>();
  usePostHog(posthogProjectKey);

  return (
    <>
      <html lang="en" className="h-full dark">
        <head>
          <ThemeScript initialPreference={themePreference} />
          <Meta />
          <Links />
        </head>
        <body className="h-full overflow-hidden bg-background-dimmed">
          <ThemeProvider initialPreference={themePreference} isLoggedIn={!!user}>
            <ShortcutsProvider>
              <Outlet />
              <Toast />
            </ShortcutsProvider>
          </ThemeProvider>
          <ScrollRestoration />
          <ExternalScripts />
          <Scripts />
          <LiveReload />
        </body>
      </html>
    </>
  );
}
