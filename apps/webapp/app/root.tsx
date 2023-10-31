import { ErrorBoundary as HighlightErrorBoundary } from "@highlight-run/react";
import type { LinksFunction, LoaderFunctionArgs } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Links, LiveReload, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import { metaV1 } from "@remix-run/v1-meta";
import { TypedMetaFunction, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExternalScripts } from "remix-utils/external-scripts";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import tailwindStylesheetUrl from "~/tailwind.css";
import { RouteErrorDisplay } from "./components/ErrorDisplay";
import { HighlightInit } from "./components/HighlightInit";
import { AppContainer, MainCenteredContainer } from "./components/layout/AppLayout";
import { Toast } from "./components/primitives/Toast";
import { env } from "./env.server";
import { featuresForRequest } from "./features.server";
import { useHighlight } from "./hooks/useHighlight";
import { usePostHog } from "./hooks/usePostHog";
import { getUser } from "./services/session.server";
import { appEnvTitleTag } from "./utils";

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: tailwindStylesheetUrl }];
};

export const meta: TypedMetaFunction<typeof loader> = (args) => {
  return metaV1(args, {
    title: `Trigger.dev${appEnvTitleTag(args.data.appEnv)}`,
    charset: "utf-8",
    viewport: "width=1024, initial-scale=1",
  });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
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
  const { posthogProjectKey, highlightProjectId } = useTypedLoaderData<typeof loader>();
  usePostHog(posthogProjectKey);
  useHighlight();

  return (
    <>
      {highlightProjectId && (
        <HighlightInit
          projectId={highlightProjectId}
          tracingOrigins={true}
          networkRecording={{ enabled: true, recordHeadersAndBody: true }}
        />
      )}
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
          <ExternalScripts />
          <Scripts />
          <LiveReload />
        </body>
      </html>
    </>
  );
}

export default App;
