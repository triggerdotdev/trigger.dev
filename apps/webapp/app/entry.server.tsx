// import * as apihero from "~/services/apihero.server";
import type { EntryContext } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { renderToString } from "react-dom/server";
import * as Sentry from "@sentry/remix";
import { prisma } from "./db.server";
import { env } from "./env.server";

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  // deepcode ignore Ssti: <This is recommended by Remix>
  const markup = renderToString(
    // deepcode ignore OR: <All good in the hood>
    <RemixServer context={remixContext} url={request.url} />
  );

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");

  return new Response("<!DOCTYPE html>" + markup, {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}

if (process.env.NODE_ENV === "production") {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1,
    integrations: [new Sentry.Integrations.Prisma({ client: prisma })],
  });

  console.log("🚦 Sentry initialized");
}

// apihero.proxy.start(() => {
//   console.info("🔶 API Hero proxy running");
// });
