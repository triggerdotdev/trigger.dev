import * as Worker from "~/services/worker.server";
import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import { Response } from "@remix-run/node"; // or cloudflare/deno
import type { EntryContext, Headers } from "@remix-run/node"; // or cloudflare/deno
import { parseAcceptLanguage } from "intl-parse-accept-language";
import isbot from "isbot";
import { LocaleContextProvider } from "./components/primitives/LocaleProvider";
import {
  OperatingSystemContextProvider,
  OperatingSystemPlatform,
} from "./components/primitives/OperatingSystemProvider";
import { logger } from "./services/logger.server";

const ABORT_DELAY = 30000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  const acceptLanguage = request.headers.get("accept-language");
  const locales = parseAcceptLanguage(acceptLanguage, {
    validate: Intl.DateTimeFormat.supportedLocalesOf,
  });

  //get whether it's a mac or pc from the headers
  const platform: OperatingSystemPlatform = request.headers
    .get("user-agent")
    ?.includes("Mac")
    ? "mac"
    : "windows";

  // If the request is from a bot, we want to wait for the full
  // response to render before sending it to the client. This
  // ensures that bots can see the full page content.
  if (isbot(request.headers.get("user-agent"))) {
    return serveTheBots(
      request,
      responseStatusCode,
      responseHeaders,
      remixContext,
      locales,
      platform
    );
  }

  return serveBrowsers(
    request,
    responseStatusCode,
    responseHeaders,
    remixContext,
    locales,
    platform
  );
}

function serveTheBots(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
  locales: string[],
  platform: OperatingSystemPlatform
) {
  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <OperatingSystemContextProvider platform={platform}>
        <LocaleContextProvider locales={locales}>
          <RemixServer
            context={remixContext}
            url={request.url}
            abortDelay={ABORT_DELAY}
          />
        </LocaleContextProvider>
      </OperatingSystemContextProvider>,
      {
        // Use onAllReady to wait for the entire document to be ready
        onAllReady() {
          responseHeaders.set("Content-Type", "text/html");
          let body = new PassThrough();
          pipe(body);
          resolve(
            new Response(body, {
              status: responseStatusCode,
              headers: responseHeaders,
            })
          );
        },
        onShellError(err: unknown) {
          reject(err);
        },
      }
    );
    setTimeout(abort, ABORT_DELAY);
  });
}

function serveBrowsers(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
  locales: string[],
  platform: OperatingSystemPlatform
) {
  return new Promise((resolve, reject) => {
    let didError = false;
    const { pipe, abort } = renderToPipeableStream(
      <OperatingSystemContextProvider platform={platform}>
        <LocaleContextProvider locales={locales}>
          <RemixServer
            context={remixContext}
            url={request.url}
            abortDelay={ABORT_DELAY}
          />
        </LocaleContextProvider>
      </OperatingSystemContextProvider>,
      {
        // use onShellReady to wait until a suspense boundary is triggered
        onShellReady() {
          responseHeaders.set("Content-Type", "text/html");
          let body = new PassThrough();
          pipe(body);
          resolve(
            new Response(body, {
              status: didError ? 500 : responseStatusCode,
              headers: responseHeaders,
            })
          );
        },
        onShellError(err: unknown) {
          reject(err);
        },
        onError(err: unknown) {
          didError = true;
          console.error(err);
        },
      }
    );
    setTimeout(abort, ABORT_DELAY);
  });
}

Worker.init().catch(console.error);
