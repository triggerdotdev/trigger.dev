import type { EntryContext } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { renderToString } from "react-dom/server";
import * as Sentry from "@sentry/remix";
import * as MessageBroker from "~/services/messageBroker.server";
import * as WebhookProxy from "~/services/webhookProxy.server";
import { prisma } from "./db.server";

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

if (process.env.NODE_ENV === "production" && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1,
    integrations: [new Sentry.Integrations.Prisma({ client: prisma })],
  });

  console.log("🚦 Sentry initialized");
}

MessageBroker.init();
WebhookProxy.init();
