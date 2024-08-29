import type { LoaderFunctionArgs } from "@remix-run/node";
import { env } from "~/env.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const originUrl = new URL(`${env.ELECTRIC_ORIGIN}/v1/shape/public."TaskEvent"`);
  url.searchParams.forEach((value, key) => {
    originUrl.searchParams.set(key, value);
  });

  originUrl.searchParams.set("where", `"traceId"='${params.traceId}'`);

  // When proxying long-polling requests, content-encoding & content-length are added
  // erroneously (saying the body is gzipped when it's not) so we'll just remove
  // them to avoid content decoding errors in the browser.
  //
  // Similar-ish problem to https://github.com/wintercg/fetch/issues/23
  let response = await fetch(originUrl.toString());
  if (response.headers.get(`content-encoding`)) {
    const headers = new Headers(response.headers);
    headers.delete(`content-encoding`);
    headers.delete(`content-length`);
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}
