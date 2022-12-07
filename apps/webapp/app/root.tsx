import type {
  LinksFunction,
  LoaderFunction,
  MetaFunction,
} from "@remix-run/node";
import {
  Links,
  LiveReload,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useCatch,
} from "@remix-run/react";
import { rootAuthLoader } from "@clerk/remix/ssr.server";

import tailwindStylesheetUrl from "./styles/tailwind.css";

import { Toaster, toast } from "react-hot-toast";

import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import { useEffect, useRef } from "react";
import posthog from "posthog-js";
import { withSentry } from "@sentry/remix";
import { env } from "./env.server";
import { getUserById } from "./models/user.server";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ClerkApp, ClerkCatchBoundary } from "@clerk/remix";
import { Title } from "./components/primitives/text/Title";

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: tailwindStylesheetUrl }];
};

export const meta: MetaFunction = () => ({
  charset: "utf-8",
  title: "API Hero",
  viewport: "width=device-width,initial-scale=1",
});

type LoaderData = {
  user: Awaited<ReturnType<typeof getUserById>>;
  toastMessage: ToastMessage | null;
  posthogProjectKey?: string;
};

export const loader: LoaderFunction = async (args) => {
  const { request } = args;
  const session = await getSession(request.headers.get("cookie"));
  const toastMessage = session.get("toastMessage") as ToastMessage;
  const posthogProjectKey = env.POSTHOG_PROJECT_KEY;

  return rootAuthLoader(args, async ({ request }) => {
    const { sessionId, userId, getToken } = request.auth;

    return typedjson<LoaderData>(
      {
        user: userId ? await getUserById(userId) : null,
        toastMessage,
        posthogProjectKey,
      },
      { headers: { "Set-Cookie": await commitSession(session) } }
    );
  });
};

export const CatchBoundary = ClerkCatchBoundary(ErrorBoundary);

//todo we need to style the error page
export function ErrorBoundary() {
  const caught = useCatch();
  return (
    <html>
      <head>
        <title>Oh no!</title>
        <Meta />
        <Links />
      </head>
      <body>
        <Title>
          {caught.status} {caught.statusText}
        </Title>
        <Scripts />
      </body>
    </html>
  );
}

function App() {
  const { toastMessage, posthogProjectKey, user } =
    useTypedLoaderData<LoaderData>();
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
        <Toaster position="top-right" />
        <ScrollRestoration />
        <Scripts />
        <LiveReload />
      </body>
    </html>
  );
}

export default withSentry(ClerkApp(App));
