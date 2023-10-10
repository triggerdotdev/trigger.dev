import type { TriggerClient } from "@trigger.dev/sdk";

export async function createRedwoodHandler(request: Request, client: TriggerClient) {
    if (request.method === "HEAD") {
        return new Response(null, { status: 200 });
    }
    try {
        // Prepare the request to be a fetch-compatible Request object:
        const requestMethod = request.method;
        const requestHeaders = request.headers;
        const responseHeaders: Record<string, string> = {};

        for (const [headerName, headerValue] of requestHeaders.entries()) {
            responseHeaders[headerName] = headerValue;
        }

        // Create a new Request object to be passed to the TriggerClient
        // where we pass the clone of the incoming request metadata such as
        // headers, method, body.
        const requestBody = await request.text();
        const requestClone = new Request("https://redwood/api/trigger", {
            headers: responseHeaders,
            method: requestMethod,
            body: requestBody,
        });

        // This handshake handler knows how to authenticate requests,
        // call the run() function of the job, and so on
        const response = await client.handleRequest(requestClone);

        if (!response) {
            return new Response(JSON.stringify({ error: "Not found" }), {
                status: 404,
            });
        }

        // Optionally, you can do something with the job's finished
        // execution's response body
        return new Response(JSON.stringify(response.body), {
            status: response.status,
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
        });
    }
}
