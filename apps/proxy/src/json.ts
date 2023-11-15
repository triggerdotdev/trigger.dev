export function json(body: any, init?: ResponseInit) {
  const headers = {
    "content-type": "application/json",
    ...(init?.headers ?? {}),
  };

  const responseInit: ResponseInit = {
    ...(init ?? {}),
    headers,
  };

  return new Response(JSON.stringify(body), responseInit);
}
