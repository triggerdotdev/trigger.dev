import type { RequestHandler } from "express";

export function createMcpProtectedResourceHandler(options: {
  origin: string;
  authorizationServers: string[];
}): RequestHandler {
  const metadata = {
    resource: `${options.origin}/mcp`,
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  };

  return (_req, res) => {
    res.json(metadata);
  };
}
