import type { LinksFunction, LoaderArgs, MetaFunction } from "@remix-run/node";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "@remix-run/react";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import tailwindStylesheetUrl from "~/tailwind.css";
import { getUser } from "./services/session.server";
import { Toaster, toast } from "react-hot-toast";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import { useEffect } from "react";
import { withSentry } from "@sentry/remix";
import { env } from "./env.server";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { usePostHog } from "./hooks/usePostHog";
import { LinkButton } from "./components/primitives/Buttons";
import { Paragraph } from "./components/primitives/Paragraph";
import {
  AppContainer,
  BackgroundGradient,
  MainCenteredContainer,
} from "./components/layout/AppLayout";
import { Header1, Header2, Header3 } from "./components/primitives/Headers";
import { friendlyErrorDisplay } from "./utils/httpErrors";

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: tailwindStylesheetUrl }];
};

export const meta: MetaFunction = () => ({
  charset: "utf-8",
  title: "Trigger",
  viewport: "width=device-width,initial-scale=1",
});

export const loader = async ({ request }: LoaderArgs) => {
  const session = await getSession(request.headers.get("cookie"));
  const toastMessage = session.get("toastMessage") as ToastMessage;
  const posthogProjectKey = env.POSTHOG_PROJECT_KEY;

  return typedjson(
    {
      user: await getUser(request),
      toastMessage,
      posthogProjectKey,
    },
    { headers: { "Set-Cookie": await commitSession(session) } }
  );
};

export const shouldRevalidate: ShouldRevalidateFunction = (options) => {
  if (options.formAction === "/resources/environment") {
    return false;
  }

  return true;
};

export function ErrorBoundary() {
  const error = useRouteError();

  return (
    <html>
      <head>
        <title>Oops!</title>
        <Meta />
        <Links />
      </head>
      <body className="bg-darkBackground h-full overflow-hidden">
        <div className="grid h-full w-full">
          <AppContainer showBackgroundGradient={true}>
            <div></div>
            <MainCenteredContainer>
              <div>
                {isRouteErrorResponse(error) ? (
                  <ErrorDisplay
                    title={
                      friendlyErrorDisplay(error.status, error.statusText).title
                    }
                    message={
                      error.data.message ??
                      friendlyErrorDisplay(error.status, error.statusText)
                        .message
                    }
                  />
                ) : error instanceof Error ? (
                  <ErrorDisplay title={error.name} message={error.message} />
                ) : (
                  <ErrorDisplay title="Oops" message={JSON.stringify(error)} />
                )}
              </div>
            </MainCenteredContainer>
          </AppContainer>
        </div>
        <Scripts />
      </body>
    </html>
  );
}

function ErrorDisplay({ title, message }: { title: string; message?: string }) {
  return (
    <div className="p-4">
      <Header1 className="mb-4 border-b border-slate-800 pb-4">{title}</Header1>
      {message && <Header3>{message}</Header3>}
      <LinkButton to="/" variant="primary/medium" className="mt-8">
        Home
      </LinkButton>
    </div>
  );
}

function App() {
  const { toastMessage, posthogProjectKey } =
    useTypedLoaderData<typeof loader>();
  usePostHog(posthogProjectKey);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const { message, type } = toastMessage;

    switch (type) {
      case "success":
        toast.success(message);
        break;
      case "error":
        toast.error(message);
        break;
      default:
        throw new Error(`${type} is not handled`);
    }
  }, [toastMessage]);

  return (
    <html lang="en" className="h-full">
      <head>
        <Meta />
        <Links />
      </head>
      <body className="bg-darkBackground h-full overflow-hidden">
        <Outlet />
        <Toaster
          position="top-right"
          toastOptions={{
            className: "",
            success: {
              style: {
                border: "1px solid #10B981",
                background: "#D1FAE5",
                padding: "16px 20px",
                color: "#1E293B",
                maxWidth: "500px",
              },
              iconTheme: {
                primary: "#10B981",
                secondary: "#D1FAE5",
              },
              duration: 5000,
            },
            error: {
              style: {
                border: "1px solid #F43F5E",
                background: "#FFE4E6",
                padding: "16px 20px",
                color: "#1E293B",
                maxWidth: "500px",
              },
              iconTheme: {
                primary: "#F43F5E",
                secondary: "#FFE4E6",
              },
              duration: 5000,
            },
          }}
        />
        <ScrollRestoration />
        <Scripts />
        <LiveReload />
      </body>
    </html>
  );
}

export default withSentry(App);
