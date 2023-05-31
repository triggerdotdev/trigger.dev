import {
  CheckCircleIcon,
  ExclamationCircleIcon,
} from "@heroicons/react/24/solid";
import type { LinksFunction, LoaderArgs, MetaFunction } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
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
import { withSentry } from "@sentry/remix";
import { useEffect } from "react";
import { Toaster, resolveValue, toast } from "react-hot-toast";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
import tailwindStylesheetUrl from "~/tailwind.css";
import {
  AppContainer,
  MainCenteredContainer,
} from "./components/layout/AppLayout";
import { NavBar } from "./components/navigation/NavBar";
import { LinkButton } from "./components/primitives/Buttons";
import { Header1, Header3 } from "./components/primitives/Headers";
import { env } from "./env.server";
import { usePostHog } from "./hooks/usePostHog";
import { getUser } from "./services/session.server";
import { friendlyErrorDisplay } from "./utils/httpErrors";
import { AnimatePresence, motion } from "framer-motion";

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
      <body className="h-full overflow-hidden bg-darkBackground">
        <div className="grid h-full w-full">
          <AppContainer showBackgroundGradient={true}>
            <NavBar />
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
      <body className="h-full overflow-hidden bg-darkBackground">
        <Outlet />
        <Toaster
          position="bottom-right"
          toastOptions={{
            success: {
              icon: <CheckCircleIcon className="h-6 w-6 text-green-600" />,
              duration: 5000,
            },
            error: {
              icon: <ExclamationCircleIcon className="h-6 w-6 text-rose-600" />,
              duration: 5000,
            },
          }}
        >
          {(t) => (
            <AnimatePresence>
              <motion.div
                className="flex gap-2 rounded-lg border border-slate-750 bg-no-repeat p-4 text-bright shadow-md"
                style={{
                  opacity: t.visible ? 1 : 0,
                  background:
                    "radial-gradient(at top, hsla(271, 91%, 65%, 0.18), hsla(221, 83%, 53%, 0.18)) hsla(221, 83%, 53%, 0.18)",
                }}
                initial={{ opacity: 0, y: 100 }}
                animate={t.visible ? "visible" : "hidden"}
                variants={{
                  hidden: {
                    opacity: 0,
                    y: 0,
                    transition: {
                      duration: 0.15,
                      ease: "easeInOut",
                    },
                  },
                  visible: {
                    opacity: 1,
                    y: 0,
                    transition: {
                      duration: 0.3,
                      ease: "easeInOut",
                    },
                  },
                }}
              >
                {t.icon}
                {resolveValue(t.message, t)}
              </motion.div>
            </AnimatePresence>
          )}
        </Toaster>
        <ScrollRestoration />
        <Scripts />
        <LiveReload />
      </body>
    </html>
  );
}

export default withSentry(App);
