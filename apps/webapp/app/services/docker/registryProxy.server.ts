import { env } from "~/env.server";
import { authenticateApiKey } from "../apiAuth.server";
import { logger } from "../logger.server";

export class RegistryProxy {
  constructor(public readonly host: string, private auth: { username: string; password: string }) {}

  public async call(request: Request) {
    return await this.#proxyRequest(request);
  }

  // Proxies the request to the registry
  async #proxyRequest(request: Request) {
    const credentials = this.#getBasicAuthCredentials(request);

    if (!credentials) {
      logger.debug("Returning 401 because credentials are missing");

      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Access to the registry"',
        },
      });
    }

    // Authenticate the request
    const authenticatedEnv = await authenticateApiKey(credentials.password, {
      allowPublicKey: false,
    });

    if (!authenticatedEnv) {
      return new Response("Unauthorized", {
        status: 401,
      });
    }

    // construct a new url based on the url passed in and the registry url
    const proxiedUrl = new URL(request.url);
    proxiedUrl.host = this.host;

    // Update the protocol to https if there is the x-forwarded-proto header
    if (request.headers.get("x-forwarded-proto") === "https") {
      proxiedUrl.protocol = "https:";
    }

    const updatedHeaders = this.#updateHeaders(request.headers);

    const response = await fetch(proxiedUrl, {
      method: request.method,
      headers: updatedHeaders,
      body: request.body,
    });

    const updatedResponseHeaders = this.#updateResponseHeaders(response.headers, request.url);

    logger.debug("proxied request/response", {
      proxiedUrl,
      status: response.status,
      statusText: response.statusText,
      method: request.method,
      requestHeaders: Object.fromEntries(updatedHeaders.entries()),
      responseHeaders: Object.fromEntries(updatedResponseHeaders.entries()),
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: updatedResponseHeaders,
    });
  }

  #getBasicAuthCredentials(request: Request) {
    const authHeader = request.headers.get("authorization");

    if (!authHeader) {
      return;
    }

    const [type, credentials] = authHeader.split(" ");

    if (type.toLowerCase() !== "basic") {
      return;
    }

    const decoded = Buffer.from(credentials, "base64").toString("utf-8");
    const [username, password] = decoded.split(":");

    return { username, password };
  }

  // Updates the headers to be sent to the registry
  // adds the docker auth
  #updateHeaders(headers: Headers): Headers {
    const newHeaders = new Headers(headers);

    // Remove host, connection, accept-encoding, content-length, and authorization headers
    newHeaders.delete("host");
    newHeaders.delete("connection");
    newHeaders.delete("accept-encoding");
    newHeaders.delete("authorization");
    newHeaders.delete("content-length");

    newHeaders.set(
      "authorization",
      `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`
    );

    return newHeaders;
  }

  // Updates the headers to be sent back to the client
  #updateResponseHeaders(headers: Headers, proxyUrl: string): Headers {
    const newHeaders = new Headers(headers);

    // Rewrite location headers to point to the proxy
    if (headers.has("location")) {
      const location = headers.get("location");

      if (location) {
        const proxiedLocation = new URL(location);
        proxiedLocation.host = new URL(proxyUrl).host;

        newHeaders.set("location", proxiedLocation.href);
      }
    }

    return newHeaders;
  }
}

export async function proxyToRegistry(request: Request) {
  if (!env.DOCKER_REGISTRY_HOST || !env.DOCKER_REGISTRY_USERNAME || !env.DOCKER_REGISTRY_PASSWORD) {
    return new Response(
      "Could not proxy to the registry, please double check your DOCKER_REGISTRY_* env vars",
      { status: 500 }
    );
  }

  const registryProxy = new RegistryProxy(env.DOCKER_REGISTRY_HOST, {
    username: env.DOCKER_REGISTRY_USERNAME,
    password: env.DOCKER_REGISTRY_PASSWORD,
  });

  return await registryProxy.call(request);
}
