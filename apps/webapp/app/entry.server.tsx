import type { EntryContext } from "@remix-run/node";
import { Response } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { renderToString } from "react-dom/server";
import * as MessageBroker from "~/services/messageBroker.server";
import * as Sentry from "~/services/sentry.server";

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

Sentry.init();
MessageBroker.init();
