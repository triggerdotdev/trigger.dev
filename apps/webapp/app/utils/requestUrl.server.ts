// Updates the protocol of the request url to match the request.headers x-forwarded-proto
export function requestUrl(request: Request): URL {
  const url = new URL(request.url);

  if (request.headers.get("x-forwarded-proto") === "https") {
    url.protocol = "https:";
  }

  return url;
}
