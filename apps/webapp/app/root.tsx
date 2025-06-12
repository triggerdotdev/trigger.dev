import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Links, LiveReload, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExternalScripts } from "remix-utils/external-scripts";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import tailwindStylesheetUrl from "~/tailwind.css";
import { AskAIProvider } from "./components/AskAI";
import { RouteErrorDisplay } from "./components/ErrorDisplay";
import { AppContainer, MainCenteredContainer } from "./components/layout/AppLayout";
import { ShortcutsProvider } from "./components/primitives/ShortcutsProvider";
import { Toast } from "./components/primitives/Toast";
import { env } from "./env.server";
import { featuresForRequest } from "./features.server";
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
        <body className="h-full overflow-hidden bg-background-dimmed">
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
        <body className="h-full overflow-hidden bg-background-dimmed">
          <AskAIProvider websiteId={kapa.websiteId || null}>
            <ShortcutsProvider>
              <Outlet />
              <Toast />
            </ShortcutsProvider>
          </AskAIProvider>
          <ScrollRestoration />
          <ExternalScripts />
          <Scripts />
          <LiveReload />
        </body>
      </html>
    </>
  );
}
