export function createAstroRoute(client) {
  return async function astroRoute(ctx) {
    if (ctx.request.method === "HEAD") {
      return new Response(null, { status: 200 });
    }

    try {
      // Prepare the request to be a fetch-compatible Request object:
      const requestHeaders = ctx.request.headers;
      const requestMethod = ctx.request.method;
      const responseHeaders = Object.create(null);

      for (const [headerName, headerValue] of requestHeaders.entries()) {
        responseHeaders[headerName] = headerValue;
      }

      // Create a new Request object to be passed to the TriggerClient
      // where we pass the clone the incoming request metadata such as
      // headers, method, body.
      const request = new Request("https://express.js/api/trigger", {
        headers: responseHeaders,
        method: requestMethod,
        body: ctx.request.body ? ctx.request.body : ctx.request,
        duplex: "half",
      });

      // This handshake handler knows how to authenticate requests,
      // call the run() function of the job, and so on
      const response = await client.handleRequest(request);

      if (!response) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
        });
      }

      // Optionally can do something with the job's finished
      // execution's response body
      return new Response(JSON.stringify(response.body), {
        status: response.status,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
      });
    }
  };
}
