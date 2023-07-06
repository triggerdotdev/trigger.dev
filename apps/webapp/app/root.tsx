import type { LinksFunction, LoaderArgs } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import {
  TypedMetaFunction,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import tailwindStylesheetUrl from "~/tailwind.css";
import { RouteErrorDisplay } from "./components/ErrorDisplay";
import { HighlightInit } from "./components/HighlightInit";
import {
  AppContainer,
  MainCenteredContainer,
} from "./components/layout/AppLayout";
import { Toast } from "./components/primitives/Toast";
import { env } from "./env.server";
import { featuresForRequest } from "./features.server";
import { usePostHog } from "./hooks/usePostHog";
import { getUser } from "./services/session.server";
import { appEnvTitleTag } from "./utils";
import { ErrorBoundary as HighlightErrorBoundary } from "@highlight-run/react";

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: tailwindStylesheetUrl }];
};

export const meta: TypedMetaFunction<typeof loader> = ({ data }) => ({
  title: `Trigger.dev${appEnvTitleTag(data?.appEnv)}`,
  charset: "utf-8",
  viewport: "width=device-width,initial-scale=1",
});

export const loader = async ({ request }: LoaderArgs) => {
  const session = await getSession(request.headers.get("cookie"));
  const toastMessage = session.get("toastMessage") as ToastMessage;
  const posthogProjectKey = env.POSTHOG_PROJECT_KEY;
  const highlightProjectId = env.HIGHLIGHT_PROJECT_ID;
  const features = featuresForRequest(request);

  return typedjson(
    {
      user: await getUser(request),
      toastMessage,
      posthogProjectKey,
      highlightProjectId,
      features,
      appEnv: env.APP_ENV,
      appOrigin: env.APP_ORIGIN,
    },
    { headers: { "Set-Cookie": await commitSession(session) } }
  );
};

export type LoaderType = typeof loader;

export const shouldRevalidate: ShouldRevalidateFunction = (options) => {
  if (options.formAction === "/resources/environment") {
    return false;
  }

  return true;
};

export function ErrorBoundary() {
  return (
    <>
      <html lang="en" className="h-full">
        <head>
          <Meta />
          <Links />
        </head>
        <body className="h-full overflow-hidden bg-darkBackground">
          <AppContainer showBackgroundGradient={true}>
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

function App() {
  const { posthogProjectKey, highlightProjectId } =
    useTypedLoaderData<typeof loader>();
  usePostHog(posthogProjectKey);

  return (
    <>
      <HighlightInit projectId={highlightProjectId} />
      <html lang="en" className="h-full">
        <head>
          <Meta />
          <Links />
        </head>
        <body className="h-full overflow-hidden bg-darkBackground">
          <HighlightErrorBoundary>
            <Outlet />
          </HighlightErrorBoundary>
          <Toast />
          <ScrollRestoration />
          <Scripts />
          <LiveReload />
        </body>
      </html>
    </>
  );
}

export default App;
