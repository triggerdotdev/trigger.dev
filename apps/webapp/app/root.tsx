import type { LinksFunction, LoaderArgs, MetaFunction } from "@remix-run/node";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

import tailwindStylesheetUrl from "./styles/tailwind.css";
import prismStylesheetUrl from "./styles/prism.css";
import prismThemeStylesheetUrl from "./styles/prism-trigger-theme.css";
import { getUser } from "./services/session.server";
import { Toaster, toast } from "react-hot-toast";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import { withSentry } from "@sentry/remix";
import { env } from "./env.server";
import { typedjson, useTypedLoaderData } from "remix-typedjson";

export const links: LinksFunction = () => {
  return [
    { rel: "stylesheet", href: tailwindStylesheetUrl },
    { rel: "stylesheet", href: prismStylesheetUrl },
    { rel: "stylesheet", href: prismThemeStylesheetUrl },
  ];
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

function App() {
  const { toastMessage, posthogProjectKey, user } =
    useTypedLoaderData<typeof loader>();
  const postHogInitialised = useRef<boolean>(false);

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

  useEffect(() => {
    if (posthogProjectKey !== undefined) {
      posthog.init(posthogProjectKey, {
        api_host: "https://app.posthog.com",
        loaded: function (posthog) {
          if (user !== null) {
            posthog.identify(user.id, { email: user.email });
          }
        },
      });
      postHogInitialised.current = true;
    }
  });

  useEffect(() => {
    if (postHogInitialised.current) {
      if (user === null) {
        posthog.reset();
      } else {
        posthog.identify(user.id, { email: user.email });
      }
    }
  }, [user]);

  return (
    <html lang="en" className="h-full">
      <head>
        <Meta />
        <Links />
      </head>
      <body className="h-full overflow-hidden">
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
              },
              iconTheme: {
                primary: "#10B981",
                secondary: "#D1FAE5",
              },
            },
            error: {
              style: {
                border: "1px solid #F43F5E",
                background: "#FFE4E6",
                padding: "16px 20px",
                color: "#1E293B",
              },
              iconTheme: {
                primary: "#F43F5E",
                secondary: "#FFE4E6",
              },
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
