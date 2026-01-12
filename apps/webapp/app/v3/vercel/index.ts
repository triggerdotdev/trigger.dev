/**
 * Vercel integration module.
 *
 * This module provides types and utilities for the Vercel integration feature.
 */

export * from "./vercelProjectIntegrationSchema";

/**
 * Extract Vercel installation parameters from a request URL.
 */
export function getVercelInstallParams(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const configurationId = url.searchParams.get("configurationId");
  const integration = url.searchParams.get("integration");
  const next = url.searchParams.get("next");

  if (code && configurationId && (integration === "vercel" || !integration)) {
    return { code, configurationId, next };
  }

  return null;
}


