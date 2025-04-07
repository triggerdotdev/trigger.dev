import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
} from "@remix-run/react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExternalScripts } from "remix-utils/external-scripts";
import { commitSession, getSession } from "~/models/message.server";
import type { ToastMessage } from "~/models/message.server";
import tailwindStylesheetUrl from "~/tailwind.css";
import { RouteErrorDisplay } from "./components/ErrorDisplay";
import { AppContainer, MainCenteredContainer } from "./components/layout/AppLayout";
import { Toast } from "./components/primitives/Toast";
import { env } from "./env.server";
import { featuresForRequest } from "./features.server";
import { usePostHog } from "./hooks/usePostHog";
import { getUser } from "./services/session.server";
import { appEnvTitleTag } from "./utils";
import { type Handle } from "./utils/handle";
import { useEffect } from "react";
import { useTypedMatchesData } from "./hooks/useTypedMatchData";

declare global {
  interface Window {
    Kapa: (command: string, options?: (() => void) | { onRender?: () => void }) => void;
  }
}

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: tailwindStylesheetUrl }];
};

export const meta: MetaFunction = ({ data }) => {
  const typedData = data as UseDataFunctionReturn<typeof loader>;
  return [
    { title: `Trigger.dev${appEnvTitleTag(typedData.appEnv)}` },
    {
      name: "viewport",
      content: "width=1024, initial-scale=1",
    },
    {
      name: "robots",
      content: typedData.features.isManagedCloud ? "index, follow" : "noindex, nofollow",
    },
  ];
};

export function useKapa() {
  const matches = useMatches();
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: "root",
    matches,
  });
  return routeMatch?.kapa;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await getSession(request.headers.get("cookie"));
  const toastMessage = session.get("toastMessage") as ToastMessage;
  const posthogProjectKey = env.POSTHOG_PROJECT_KEY;
  const features = featuresForRequest(request);

  const kapa = {
    websiteId: env.KAPA_AI_WEBSITE_ID,
  };

  return typedjson(
    {
      user: await getUser(request),
      toastMessage,
      posthogProjectKey,
      features,
      appEnv: env.APP_ENV,
      appOrigin: env.APP_ORIGIN,
      kapa,
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
      <html lang="en" className="h-full">
        <head>
          <meta charSet="utf-8" />

          <Meta />
          <Links />
        </head>
        <body className="bg-darkBackground h-full overflow-hidden">
          <AppContainer>
            <MainCenteredContainer>
              <RouteErrorDisplay />
            </MainCenteredContainer>
          </AppContainer>
          <Scripts />
        </body>
      </html>
    </>
  );
}

export default function App() {
  const { posthogProjectKey, kapa } = useTypedLoaderData<typeof loader>();
  usePostHog(posthogProjectKey);

  return (
    <>
      <html lang="en" className="h-full">
        <head>
          <Meta />
          <Links />
        </head>
        <body className="bg-darkBackground h-full overflow-hidden">
          <Outlet />
          <Toast />
          <ScrollRestoration />
          <ExternalScripts />
          <Scripts />
          <LiveReload />
        </body>
      </html>
    </>
  );
}
