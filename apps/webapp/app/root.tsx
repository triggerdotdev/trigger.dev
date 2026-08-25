import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import type { CSSProperties } from "react";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ExternalScripts } from "remix-utils/external-scripts";
import type { ToastMessage } from "~/models/message.server";
import { commitSession, getSession } from "~/models/message.server";
// Fonts imported here so Vite rebases the urls and emits the woff2 assets
import "non.geist";
import "non.geist/mono";
import tailwindStylesheetUrl from "~/tailwind.css?url";
import { RouteErrorDisplay } from "./components/ErrorDisplay";
import { GlobalShortcuts } from "./components/GlobalShortcuts";
import { StaleAssetRecovery } from "./components/StaleAssetRecovery";
import { AppContainer, MainCenteredContainer } from "./components/layout/AppLayout";
import { ShortcutsProvider } from "./components/primitives/ShortcutsProvider";
import { Toast } from "./components/primitives/Toast";
import { TimezoneSetter } from "./components/TimezoneSetter";
import { env } from "./env.server";
import { featuresForRequest } from "./features.server";
import { usePostHog } from "./hooks/usePostHog";
import { resolveThemePreference, useSystemThemeSync } from "./hooks/useSystemThemeSync";
import { clearImpersonation } from "./models/admin.server";
import { getImpersonationState, getRawImpersonationId } from "./services/impersonation.server";
import { getUser } from "./services/session.server";
import {
  normalizeIconContrast,
  normalizeSystemDarkTheme,
  normalizeSystemLightTheme,
  normalizeThemeContrast,
  normalizeUnderlineLinks,
  normalizeThemePreference,
  type ThemePreference,
} from "~/utils/themePreference";
import { cachedFlag } from "~/v3/featureFlags.server";
import { getTimezonePreference } from "./services/preferences/uiPreferences.server";
import { appTitle } from "./utils/pageTitle";

// Derived here (not inside StaleAssetRecovery) so the shared component takes
// the flag as a prop. NODE_ENV is statically replaced in browser bundles, and
// the ErrorBoundary can't rely on loader data.
const isProduction = process.env.NODE_ENV === "production";

export const links: LinksFunction = () => {
  return [{ rel: "stylesheet", href: tailwindStylesheetUrl }];
};

export const headers = () => ({
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy":
    "geolocation=(), microphone=(), camera=(), accelerometer=(), gyroscope=(), magnetometer=(), payment=(), usb=()",
});

export const meta: MetaFunction = ({ data }) => {
  const typedData = data as UseDataFunctionReturn<typeof loader>;
  return [
    // Pages declare their own title with `pageMeta`; this is the fallback.
    { title: appTitle(typedData?.appEnv) },
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
  const posthogUiHost = env.POSTHOG_HOST;
  const features = featuresForRequest(request);
  const timezone = await getTimezonePreference(request);

  // Deprecated with `AskAI.tsx`: kept so the widget still has its config if it is ever remounted.
  const kapa = {
    websiteId: env.KAPA_AI_WEBSITE_ID,
  };

  const user = await getUser(request);
  // Feature-flagged; while off everyone stays on Dark at contrast 0. Admins
  // always get it. Cached: this loader runs on every request and navigation.
  const showThemeSwitcher = user
    ? user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }))
    : false;
  // Logged-out pages always render the branded dark look.
  const themePreference: ThemePreference = showThemeSwitcher
    ? normalizeThemePreference(user?.dashboardPreferences.theme)
    : "dark";
  const themeContrast = showThemeSwitcher
    ? normalizeThemeContrast(user?.dashboardPreferences.contrast)
    : 0;
  // Forced off with the switcher hidden, so unflagged pages render the base set.
  const iconContrast = showThemeSwitcher
    ? normalizeIconContrast(user?.dashboardPreferences.iconContrast)
    : false;
  const underlineLinks = showThemeSwitcher
    ? normalizeUnderlineLinks(user?.dashboardPreferences.underlineLinks)
    : false;
  const systemThemes = {
    light: normalizeSystemLightTheme(user?.dashboardPreferences.systemLightTheme),
    dark: normalizeSystemDarkTheme(user?.dashboardPreferences.systemDarkTheme),
  };
  // Display-only: while impersonating, an admin can ask to see the dashboard
  // the way the impersonated user sees it. Exposed from root so every route can
  // read it.
  //
  // Resolved against the user this request authenticated as, which is the same
  // condition `requireUser` applies — otherwise the flag the client reads and
  // the `user.isViewingAsUser` the server computes could disagree, and the
  // client-side admin UI would hide itself on a session that is not
  // impersonating.
  // Flag off: terminate lingering impersonation sessions (audit + clear)
  // rather than leaving a cookie that would resurrect on a later re-enable.
  if (!env.ADMIN_DASHBOARD_ENABLED && (await getRawImpersonationId(request))) {
    const url = new URL(request.url);
    throw await clearImpersonation(request, `${url.pathname}${url.search}`);
  }

  const { isViewingAsUser } = await getImpersonationState(request, user?.id);

  const headers = new Headers();
  headers.append("Set-Cookie", await commitSession(session));

  return typedjson(
    {
      user,
      isViewingAsUser,
      adminDashboardEnabled: env.ADMIN_DASHBOARD_ENABLED,
      toastMessage,
      posthogProjectKey,
      posthogUiHost,
      features,
      appEnv: env.APP_ENV,
      appOrigin: env.APP_ORIGIN,
      apiOrigin: env.API_ORIGIN ?? env.APP_ORIGIN,
      dashboardAgentBaseUrl: env.DASHBOARD_AGENT_BASE_URL ?? "https://api.trigger.dev",
      triggerCliTag: env.TRIGGER_CLI_TAG,
      kapa,
      timezone,
      showThemeSwitcher,
      iconContrast,
      underlineLinks,
      themePreference,
      systemThemes,
      themeContrast,
      // Consumed by ResizablePanel: the browser check must match between SSR
      // and hydration, so it is derived from the request user-agent.
      isFirefox: /firefox/i.test(request.headers.get("user-agent") ?? ""),
    },
    { headers }
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
    <html lang="en" className="h-full" data-theme="dark">
      <head>
        <meta charSet="utf-8" />

        <StaleAssetRecovery isProduction={isProduction} />
        <Meta />
        <Links />
      </head>
      <body className="h-full overflow-hidden bg-background-dimmed antialiased">
        <ShortcutsProvider>
          <AppContainer>
            <MainCenteredContainer>
              <RouteErrorDisplay />
            </MainCenteredContainer>
          </AppContainer>
        </ShortcutsProvider>
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const {
    posthogProjectKey,
    posthogUiHost,
    themePreference,
    themeContrast,
    iconContrast,
    underlineLinks,
    systemThemes,
  } = useTypedLoaderData<typeof loader>();
  usePostHog(posthogProjectKey, posthogUiHost);
  useSystemThemeSync(themePreference, systemThemes);
  // SSR falls back to the dark end for `system`; the script below fixes it
  // before paint, and useSystemThemeSync keeps it live after.
  const resolvedTheme = resolveThemePreference(themePreference, true, systemThemes);

  return (
    <html
      lang="en"
      className="h-full"
      // The script below may flip data-theme before hydration
      suppressHydrationWarning
      data-theme={resolvedTheme}
      data-theme-preference={themePreference}
      // Read by the script below, before loader data reaches JS
      data-system-light={systemThemes.light}
      data-system-dark={systemThemes.dark}
      // The `system:` variant keys off this
      data-icon-contrast={iconContrast ? "true" : "false"}
      data-underline-links={underlineLinks ? "true" : "false"}
      // Each theme maps the percent onto its own range in CSS
      style={{ "--theme-contrast-percent": themeContrast / 100 } as CSSProperties}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var h=document.documentElement;if(h.getAttribute("data-theme-preference")==="system"){var d=matchMedia("(prefers-color-scheme: dark)").matches;h.setAttribute("data-theme",d?(h.getAttribute("data-system-dark")||"dark"):(h.getAttribute("data-system-light")||"light"))}}catch(e){}`,
          }}
        />
        <StaleAssetRecovery isProduction={isProduction} />
        <Meta />
        <Links />
      </head>
      <body className="h-full overflow-hidden bg-background-dimmed antialiased">
        <ShortcutsProvider>
          <TimezoneSetter />
          <GlobalShortcuts />
          <Outlet />
          <Toast />
        </ShortcutsProvider>
        <ScrollRestoration />
        <ExternalScripts />
        <Scripts />
      </body>
    </html>
  );
}
