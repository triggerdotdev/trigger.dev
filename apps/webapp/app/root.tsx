import type { LinksFunction, LoaderArgs, MetaFunction } from "@remix-run/node";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
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

export function ErrorBoundary({ error }: { error: any }) {
  console.error(error);
  return (
    <html>
      <head>
        <title>Oops!</title>
        <Meta />
        <Links />
      </head>
      <body className="bg-slate-850">
        <div className="flex h-screen w-screen items-center justify-center">
          <div className="flex flex-col items-center justify-center space-y-4">
            <h1>Oh no!</h1>
            <Paragraph>{JSON.stringify(error)}</Paragraph>
            <LinkButton to="/" variant="primary/small">
              Back home
            </LinkButton>
          </div>
          <Scripts />
        </div>
      </body>
    </html>
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
      <body className="h-full overflow-hidden bg-darkBackground">
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
