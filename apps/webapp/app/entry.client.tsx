import { RemixBrowser, useLocation, useMatches } from "@remix-run/react";
import { hydrateRoot } from "react-dom/client";
import { useEffect } from "react";
import posthog from "posthog-js";
import { LocaleContextProvider } from "./components/primitives/LocaleProvider";
import { OperatingSystemContextProvider } from "./components/primitives/OperatingSystemProvider";

hydrateRoot(
  document,
  <OperatingSystemContextProvider
    platform={window.navigator.userAgent.includes("Mac") ? "mac" : "windows"}
  >
    <LocaleContextProvider locales={window.navigator.languages as string[]}>
      <RemixBrowser />
    </LocaleContextProvider>
  </OperatingSystemContextProvider>
);
