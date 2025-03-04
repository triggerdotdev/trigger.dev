import { IncomingMessage, ServerResponse } from "http";
import Redis, { RedisOptions } from "ioredis";
import { RequestOptions, request as httpRequest } from "node:https";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { authenticatePersonalAccessToken } from "~/services/personalAccessToken.server";
import { singleton } from "~/utils/singleton";
import { jwtDecode } from "jwt-decode";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdtemp } from "fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { unlinkSync } from "fs";
import { parseDockerImageReference, rebuildDockerImageReference } from "@trigger.dev/core/v3";

const TokenResponseBody = z.object({
  token: z.string(),
});

const CACHED_BEARER_TOKEN_BUFFER_IN_SECONDS = 10;

type RegistryProxyOptions = {
  origin: string;
  auth: { username: string; password: string };
  redis?: RedisOptions;
};

export class RegistryProxy {
  private redis?: Redis;

  constructor(private readonly options: RegistryProxyOptions) {
    if (options.redis) {
      this.redis = new Redis(options.redis);
    }
  }

  get origin() {
    return this.options.origin;
  }

  get host() {
    return new URL(this.options.origin).host;
  }

  // If the imageReference includes a hostname, rewrite it to point to the proxy
  // e.g. eric-webapp.trigger.dev/trigger/yubjwjsfkxnylobaqvqz:20240306.41.prod@sha256:8b48dd2866bc8878644d2880bbe35a27e66cf6ff78aa1e489d7fdde5e228faf1
  // should be rewritten to ${this.host}/trigger/yubjwjsfkxnylobaqvqz:20240306.41.prod@sha256:8b48dd2866bc8878644d2880bbe35a27e66cf6ff78aa1e489d7fdde5e228faf1
  // This will work with image references that don't include the @sha256:... part
  public rewriteImageReference(imageReference: string) {
    const parts = parseDockerImageReference(imageReference);

    logger.debug("Rewriting image reference parts", { parts });

    if (parts.registry) {
      return rebuildDockerImageReference({
        ...parts,
        registry: this.host,
      });
    }

    return imageReference;
  }

  public async call(request: IncomingMessage, response: ServerResponse) {
    await this.#proxyRequest(request, response);
  }

  // Proxies the request to the registry
  async #proxyRequest(request: IncomingMessage, response: ServerResponse) {
    const credentials = this.#getBasicAuthCredentials(request);

    if (!credentials) {
      logger.debug("Returning 401 because credentials are missing");

      response.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Access to the registry"',
      });

      response.end("Unauthorized");

      return;
    }

    // Authenticate the request
    const authentication = await authenticatePersonalAccessToken(credentials.password);

    if (!authentication) {
      logger.debug("Returning 401 because authentication failed");

      response.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Access to the registry"',
      });

      response.end("Unauthorized");

      return;
    }

    // construct a new url based on the url passed in and the registry url
    const url = new URL(this.options.origin);
    const options = {
      hostname: url.hostname,
      path: request.url,
      method: request.method,
      headers: { ...request.headers },
    };

    delete options.headers["host"];
    // delete options.headers["connection"];
    // delete options.headers["accept-encoding"];
    delete options.headers["authorization"];
    // delete options.headers["content-length"];
    delete options.headers["cf-ray"];
    delete options.headers["cf-visitor"];
    delete options.headers["cf-ipcountry"];
    delete options.headers["cf-connecting-ip"];
    delete options.headers["cf-warp-tag-id"];

    // Add a custom Authorization header for the proxied request
    options.headers["authorization"] = `Basic ${Buffer.from(
      `${this.options.auth.username}:${this.options.auth.password}`
    ).toString("base64")}`;

    let tempFilePath: string | undefined;
    let cleanupTempFile: () => void = () => {};

    if (
      options.method === "POST" ||
      (options.method === "PUT" && request.headers["content-length"])
    ) {
      tempFilePath = await streamRequestBodyToTempFile(request);

      cleanupTempFile = () => {
        if (tempFilePath) {
          logger.debug("Cleaning up temp file", { tempFilePath });
          unlinkSync(tempFilePath);
        }
      };

      logger.debug("Streamed request body to temp file", { tempFilePath });
    }

    const makeProxiedRequest = (tokenOptions: RequestOptions, attempts: number = 1) => {
      logger.debug("Proxying request", {
        request: tokenOptions,
        attempts,
        originalHeaders: request.headers,
      });

      if (attempts > 10) {
        logger.error("Too many attempts to proxy request", {
          attempts,
        });

        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("Internal Server Error: Too many attempts to proxy request");

        return cleanupTempFile();
      }

      const proxyReq = httpRequest(tokenOptions, async (proxyRes) => {
        // If challenged for bearer token auth, handle it here
        if (proxyRes.statusCode === 401 && proxyRes.headers["www-authenticate"]) {
          logger.debug("Received 401 with WWW-Authenticate, attempting to fetch bearer token", {
            authenticate: proxyRes.headers["www-authenticate"],
          });

          const bearerToken = await this.#getBearerToken(proxyRes.headers["www-authenticate"]);

          if (bearerToken && tokenOptions.headers) {
            tokenOptions.headers["authorization"] = `Bearer ${bearerToken}`;
            makeProxiedRequest(tokenOptions, attempts + 1); // Retry request with bearer token
            return;
          } else {
            // Handle failed token fetch or lack of WWW-Authenticate handling
            response.writeHead(401, { "Content-Type": "text/plain" });
            response.end("Failed to authenticate with the registry using bearer token");
            return cleanupTempFile();
          }
        }

        if (proxyRes.statusCode === 401) {
          logger.debug("Received 401, but there is no www-authenticate value", {
            headers: proxyRes.headers,
          });

          response.writeHead(401, { "Content-Type": "text/plain" });
          response.end("Unauthorized");
          return cleanupTempFile();
        }

        if (proxyRes.statusCode === 301) {
          logger.debug("Received 301, attempting to follow redirect", {
            location: proxyRes.headers["location"],
          });

          const redirectOptions = {
            ...tokenOptions,
            path: proxyRes.headers["location"],
          };

          makeProxiedRequest(redirectOptions, attempts + 1);
          return;
        }

        if (!proxyRes.statusCode) {
          logger.error("No status code in the response", {
            headers: proxyRes.headers,
            statusMessage: proxyRes.statusMessage,
          });

          response.writeHead(500, { "Content-Type": "text/plain" });
          response.end("Internal Server Error: No status code in the response");

          return cleanupTempFile();
        }

        const headers = { ...proxyRes.headers };

        // Rewrite location headers to point to the proxy
        if (headers["location"]) {
          const proxiedLocation = new URL(headers.location);

          // Only rewrite the location header if the host is the same as the registry
          if (proxiedLocation.host === this.host) {
            if (!request.headers.host) {
              // Return a 500 if the host header is missing
              logger.error("Host header is missing in the request", {
                headers: request.headers,
              });

              response.writeHead(500, { "Content-Type": "text/plain" });
              response.end("Internal Server Error: Host header is missing in the request");
              return cleanupTempFile();
            }

            proxiedLocation.host = request.headers.host;

            headers["location"] = proxiedLocation.href;

            logger.debug("Rewriting location response header", {
              originalLocation: proxyRes.headers["location"],
              proxiedLocation: headers["location"],
              proxiedLocationUrl: proxiedLocation.href,
            });
          }
        }

        logger.debug("Proxying successful response", {
          method: tokenOptions.method,
          path: tokenOptions.path,
          statusCode: proxyRes.statusCode,
          responseHeaders: headers,
        });

        // Proceed as normal if not a 401 or after getting a bearer token
        response.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(response, { end: true });
      });

      request.on("close", () => {
        logger.debug("Client closed the connection");
        proxyReq.destroy();
        cleanupTempFile();
      });

      request.on("abort", () => {
        logger.debug("Client aborted the connection");
        proxyReq.destroy(); // Abort the proxied request
        cleanupTempFile(); // Clean up the temporary file if necessary
      });

      if (tempFilePath) {
        const readStream = createReadStream(tempFilePath);

        readStream.pipe(proxyReq, { end: true });
      } else {
        proxyReq.end();
      }

      proxyReq.on("error", (error) => {
        logger.error("Error proxying request", { error: error.message });

        if (response.headersSent) {
          return;
        }

        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(`Internal Server Error: ${error.message}`);
      });
    };

    makeProxiedRequest(options);
  }

  #getBasicAuthCredentials(request: IncomingMessage) {
    const headers = request.headers;

    logger.debug("Getting basic auth credentials with headers", {
      headers,
    });

    const authHeader = headers["authorization"];

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

  async #getBearerToken(authenticateHeader: string): Promise<string | undefined> {
    try {
      // Create a md5 hash of the authenticate header to use as a cache key
      const cacheKey = `token:${createHash("md5").update(authenticateHeader).digest("hex")}`;

      const cachedToken = await this.#getCachedToken(cacheKey);

      if (cachedToken) {
        return cachedToken;
      }

      // Parse the WWW-Authenticate header to extract realm and service
      const realmMatch = authenticateHeader.match(/realm="([^"]+)"/);
      const serviceMatch = authenticateHeader.match(/service="([^"]+)"/);
      // Optionally, we could also extract and use the scope parameter if required
      const scopeMatch = authenticateHeader.match(/scope="([^"]+)"/);

      if (!realmMatch || !serviceMatch) {
        logger.error("Failed to parse WWW-Authenticate header", { authenticateHeader });
        return;
      }

      const realm = realmMatch[1];
      const service = serviceMatch[1];
      // Construct the URL for fetching the token
      let authUrl = `${realm}?service=${encodeURIComponent(service)}`;
      // Include scope in the request if needed
      if (scopeMatch) {
        const scope = scopeMatch[1];
        authUrl += `&scope=${encodeURIComponent(scope)}`;
      }

      authUrl += `&account=${encodeURIComponent(this.options.auth.username)}`;

      logger.debug("Fetching bearer token", { authUrl });

      // Make the request to the authentication service
      const response = await fetch(authUrl, {
        headers: {
          authorization:
            "Basic " +
            Buffer.from(`${this.options.auth.username}:${this.options.auth.password}`).toString(
              "base64"
            ),
        },
      });

      if (!response.ok) {
        logger.debug("Failed to fetch bearer token", {
          status: response.status,
          statusText: response.statusText,
        });
        return;
      }

      const rawBody = await response.json();
      const body = TokenResponseBody.safeParse(rawBody);

      if (!body.success) {
        logger.error("Failed to parse token response", { body: rawBody });
        return;
      }

      logger.debug("Fetched bearer token", { token: body.data.token });

      await this.#setCachedToken(body.data.token, cacheKey);

      return body.data.token;
    } catch (error) {
      logger.error("Failed to fetch bearer token", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  async #getCachedToken(key: string) {
    if (!this.redis) {
      return;
    }

    const cachedToken = await this.redis.get(key);

    if (cachedToken) {
      const decoded = jwtDecode(cachedToken);
      const expiry = decoded.exp;

      if (expiry && expiry > Date.now() / 1000 + CACHED_BEARER_TOKEN_BUFFER_IN_SECONDS) {
        return cachedToken;
      }
    }
  }

  async #setCachedToken(token: string, key: string) {
    if (!this.redis) {
      return;
    }

    const decoded = jwtDecode(token);

    if (decoded.exp) {
      await this.redis.set(key, token, "EXAT", decoded.exp);
    }
  }
}

export const registryProxy = singleton("registryProxy", initializeProxy);

function initializeProxy() {
  if (
    !env.CONTAINER_REGISTRY_ORIGIN ||
    !env.CONTAINER_REGISTRY_USERNAME ||
    !env.CONTAINER_REGISTRY_PASSWORD
  ) {
    return;
  }

  if (!env.ENABLE_REGISTRY_PROXY || env.ENABLE_REGISTRY_PROXY === "false") {
    logger.info("Registry proxy is disabled");
    return;
  }

  return new RegistryProxy({
    origin: env.CONTAINER_REGISTRY_ORIGIN,
    auth: {
      username: env.CONTAINER_REGISTRY_USERNAME,
      password: env.CONTAINER_REGISTRY_PASSWORD,
    },
  });
}

async function streamRequestBodyToTempFile(request: IncomingMessage): Promise<string | undefined> {
  try {
    const tempDir = await mkdtemp(`${tmpdir()}/`);
    const tempFilePath = `${tempDir}/requestBody.tmp`;
    const writeStream = createWriteStream(tempFilePath);

    await pipeline(request, writeStream);

    return tempFilePath;
  } catch (error) {
    logger.error("Failed to stream request body to temp file", {
      error: error instanceof Error ? error.message : error,
    });

    return;
  }
}
