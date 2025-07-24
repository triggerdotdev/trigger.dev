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
import { singleton } from "./utils/singleton";
import { bootstrap } from "./bootstrap";
import { wrapHandleErrorWithSentry } from "@sentry/remix";

const ABORT_DELAY = 30000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/login")) {
    responseHeaders.set("X-Frame-Options", "SAMEORIGIN");
    responseHeaders.set("Content-Security-Policy", "frame-ancestors 'self'");
  }

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

export const handleError = wrapHandleErrorWithSentry((error, { request }) => {
  if (request instanceof Request) {
    logger.error("Error in handleError", {
      error,
      request: {
        url: request.url,
        method: request.method,
      },
    });
  } else {
    logger.error("Error in handleError", {
      error,
    });
  }
});

Worker.init().catch((error) => {
  logError(error);
});

bootstrap().catch((error) => {
  logError(error);
});

function logError(error: unknown, request?: Request) {
  console.error(error);

  if (error instanceof Error && error.message.startsWith("There are locked jobs present")) {
    console.log("⚠️  graphile-worker migration issue detected!");
  }
}

process.on("uncaughtException", (error, origin) => {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    // Don't exit the process if the error is a Prisma error
    logger.error("uncaughtException prisma error", {
      error,
      prismaMessage: error.message,
      code: "code" in error ? error.code : undefined,
      meta: "meta" in error ? error.meta : undefined,
      stack: error.stack,
      origin,
    });
  } else {
    logger.error("uncaughtException", {
      error: { name: error.name, message: error.message, stack: error.stack },
      origin,
    });
  }

  process.exit(1);
});

singleton("RunEngineEventBusHandlers", registerRunEngineEventBusHandlers);

export { apiRateLimiter } from "./services/apiRateLimit.server";
export { engineRateLimiter } from "./services/engineRateLimit.server";
export { socketIo } from "./v3/handleSocketIo.server";
export { wss } from "./v3/handleWebsockets.server";
export { runWithHttpContext } from "./services/httpAsyncStorage.server";
import { eventLoopMonitor } from "./eventLoopMonitor.server";
import { env } from "./env.server";
import { logger } from "./services/logger.server";
import { Prisma } from "./db.server";
import { registerRunEngineEventBusHandlers } from "./v3/runEngineHandlers.server";
import { remoteBuildsEnabled } from "./v3/remoteImageBuilder.server";

if (env.EVENT_LOOP_MONITOR_ENABLED === "1") {
  eventLoopMonitor.enable();
}

if (remoteBuildsEnabled()) {
  console.log("🏗️  Remote builds enabled");
} else {
  console.log("🏗️  Local builds enabled");
}
