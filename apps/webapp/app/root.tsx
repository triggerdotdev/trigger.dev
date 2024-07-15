import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration ,type  ShouldRevalidateFunction  } from "@remix-run/react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExternalScripts } from "remix-utils/external-scripts";
import { commitSession, getSession ,type  ToastMessage  } from "~/models/message.server";
import tailwindStylesheetUrl from "~/tailwind.css?url";
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
        <body className="bg-darkBackground h-full overflow-hidden">
          <Outlet />
          <Toast />
          <ScrollRestoration />
          <ExternalScripts />
          <Scripts />
        </body>
      </html>
    </>
  );
}

export default App;
