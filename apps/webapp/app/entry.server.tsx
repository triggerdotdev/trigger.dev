import { H } from "@highlight-run/node";
import {
  createReadableStreamFromReadable,
  type DataFunctionArgs,
  type EntryContext,
} from "@remix-run/node"; // or cloudflare/deno
import { RemixServer } from "@remix-run/react";
import { parseAcceptLanguage } from "intl-parse-accept-language";
import isbot from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { PassThrough } from "stream";
import * as Worker from "~/services/worker.server";
import { LocaleContextProvider } from "./components/primitives/LocaleProvider";
import {
  OperatingSystemContextProvider,
  OperatingSystemPlatform,
} from "./components/primitives/OperatingSystemProvider";
import { env } from "./env.server";

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
  const platform: OperatingSystemPlatform = request.headers.get("user-agent")?.includes("Mac")
    ? "mac"
    : "windows";

  // If the request is from a bot, we want to wait for the full
  // response to render before sending it to the client. This
  // ensures that bots can see the full page content.
  if (isbot(request.headers.get("user-agent"))) {
    return handleBotRequest(
      request,
      responseStatusCode,
      responseHeaders,
      remixContext,
      locales,
      platform
    );
  }

  return handleBrowserRequest(
    request,
    responseStatusCode,
    responseHeaders,
    remixContext,
    locales,
    platform
  );
}

function handleBotRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
  locales: string[],
  platform: OperatingSystemPlatform
) {
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const { pipe, abort } = renderToPipeableStream(
      <OperatingSystemContextProvider platform={platform}>
        <LocaleContextProvider locales={locales}>
          <RemixServer context={remixContext} url={request.url} abortDelay={ABORT_DELAY} />,
        </LocaleContextProvider>
      </OperatingSystemContextProvider>,
      {
        onAllReady() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            console.error(error);
          }
        },
      }
    );

    setTimeout(abort, ABORT_DELAY);
  });
}

function handleBrowserRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
  locales: string[],
  platform: OperatingSystemPlatform
) {
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const { pipe, abort } = renderToPipeableStream(
      <OperatingSystemContextProvider platform={platform}>
        <LocaleContextProvider locales={locales}>
          <RemixServer context={remixContext} url={request.url} abortDelay={ABORT_DELAY} />
        </LocaleContextProvider>
      </OperatingSystemContextProvider>,
      {
        onShellReady() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            console.error(error);
          }
        },
      }
    );

    setTimeout(abort, ABORT_DELAY);
  });
}

if (env.HIGHLIGHT_PROJECT_ID) {
  H.init({ projectID: env.HIGHLIGHT_PROJECT_ID });
}

export function handleError(error: unknown, { request, params, context }: DataFunctionArgs) {
  logError(error, request);
}

Worker.init().catch((error) => {
  logError(error);
});

function logError(error: unknown, request?: Request) {
  if (env.HIGHLIGHT_PROJECT_ID) {
    const parsed = request ? H.parseHeaders(Object.fromEntries(request.headers)) : undefined;
    if (error instanceof Error) {
      H.consumeError(error, parsed?.secureSessionId, parsed?.requestId);
    } else {
      H.consumeError(
        new Error(`Unknown error: ${JSON.stringify(error)}`),
        parsed?.secureSessionId,
        parsed?.requestId
      );
    }
  }
  console.error(error);
}
