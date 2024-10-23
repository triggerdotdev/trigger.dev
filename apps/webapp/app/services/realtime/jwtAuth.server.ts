import { validateJWT } from "@trigger.dev/core/v3/jwt";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";

export async function validatePublicJwtKey(token: string) {
  // Get the sub claim from the token
  // Use the sub claim to find the environment
  // Validate the token against the environment.apiKey
  // Once that's done, return the environment and the claims
  const sub = extractJWTSub(token);

  if (!sub) {
    return;
  }

  const environment = await findEnvironmentById(sub);

  if (!environment) {
    return;
  }

  const claims = await validateJWT(token, environment.apiKey);

  if (!claims) {
    return;
  }

  return {
    environment,
    claims,
  };
}

export function isPublicJWT(token: string): boolean {
  // Split the token
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  try {
    // Decode the payload (second part)
    const payload = JSON.parse(decodeBase64Url(parts[1]));

    if (payload === null || typeof payload !== "object") return false;

    // Check for the pub: true claim
    return "pub" in payload && payload.pub === true;
  } catch (error) {
    // If there's any error in decoding or parsing, it's not a valid JWT
    return false;
  }
}

function extractJWTSub(token: string): string | undefined {
  // Split the token
  const parts = token.split(".");
  if (parts.length !== 3) return;

  try {
    // Decode the payload (second part)
    const payload = JSON.parse(decodeBase64Url(parts[1]));

    if (payload === null || typeof payload !== "object") return;

    // Check for the pub: true claim
    return "sub" in payload && typeof payload.sub === "string" ? payload.sub : undefined;
  } catch (error) {
    // If there's any error in decoding or parsing, it's not a valid JWT
    return;
  }
}

function decodeBase64Url(str: string): string {
  // Replace URL-safe characters and add padding
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  switch (str.length % 4) {
    case 2:
      str += "==";
      break;
    case 3:
      str += "=";
      break;
  }

  // Decode using Node.js Buffer
  return Buffer.from(str, "base64").toString("utf8");
}
