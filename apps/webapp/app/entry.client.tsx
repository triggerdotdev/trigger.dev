import { RemixBrowser } from "@remix-run/react";
import { hydrateRoot } from "react-dom/client";
import { clientBeforeFirstRender } from "./clientBeforeFirstRender";
import { LocaleContextProvider } from "./components/primitives/LocaleProvider";
import { OperatingSystemContextProvider } from "./components/primitives/OperatingSystemProvider";

clientBeforeFirstRender();

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
